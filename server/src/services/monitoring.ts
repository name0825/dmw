import { getDb, withTransaction } from '../database/index.js'
import { evaluateAlerts } from '../alerts.js'
import { notifyAlerts, saveAlertsToDb } from './notifications.js'
import { broadcastState } from './ws.js'
import { evaluateDeviceStatus } from '../deviceStatus.js'
import { ALERT_COOLDOWN_MS, ALERT_RETENTION_MS, STATUS_ONLINE, STATUS_OFFLINE, STATUS_WAKE_TIMEOUT } from '../config/constants.js'

// Store timestamps of last sent alerts to prevent spamming.
// 프로세스 메모리에만 저장되므로 서버 재시작 시 초기화됨.
const lastAlertTimestamps = new Map<string, number>()

/** 메트릭 이력 보존 기간 — 7 일 (밀리초). */
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 이력 정리 최소 실행 간격 — 하루. */
const HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

// 마지막 이력 정리 실행 시각. updateOfflineStates 는 10 초마다 호출되므로,
// 매번 DELETE 를 돌리지 않도록 하루에 한 번 정도만 실행되게 스로틀함.
let lastHistoryPruneAt = 0

/**
 * device_metrics_history 에서 보존 기간이 지난 오래된 행을 삭제함.
 */
export const pruneMetricsHistory = async () => {
  const cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString()
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM device_metrics_history WHERE timestamp < ?', [cutoff])
  })
}

/**
 * alerts 에서 보존 기간이 지난 오래된 행을 삭제함.
 */
export const pruneAlerts = async () => {
  const cutoff = new Date(Date.now() - ALERT_RETENTION_MS).toISOString()
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM alerts WHERE created_at < ?', [cutoff])
  })
}

/**
 * 기기 상태 업데이트 및 오프라인 상태 관리.
 * 백그라운드에서 주기적으로 실행되며, last_seen 와 updated_at 를 기반으로
 * 기기 상태를 평가하고 DB 에 갱신함.
 */
export const updateOfflineStates = async () => {
  const devices = await getDb().all(
    'SELECT * FROM devices WHERE status IN (?, ?, ?) ORDER BY id DESC',
    [STATUS_ONLINE, STATUS_OFFLINE, STATUS_WAKE_TIMEOUT],
  )

  await withTransaction(async (tx) => {
    for (const device of devices) {
      const nextStatus = evaluateDeviceStatus(device, new Date())
      if (nextStatus !== device.status) {
        await tx.run(
          'UPDATE devices SET status = ?, updated_at = ? WHERE id = ?',
          [nextStatus, new Date().toISOString(), device.id],
        )
      }
    }
  })

  // 이력·알림 정리는 10 초마다 도는 이 루프에서 매번 DELETE 를 실행하지 않도록
  // 하루에 한 번 정도만 실행되게 스로틀함 (routes.ts 에 별도 스케줄러를 둘 수 없어 여기서 처리).
  if (Date.now() - lastHistoryPruneAt > HISTORY_PRUNE_INTERVAL_MS) {
    lastHistoryPruneAt = Date.now()
    await pruneMetricsHistory()
    await pruneAlerts()
  }

  await broadcastState()
}

/**
 * 알람 평가 및 알림 발송.
 * 기기 메트릭스를 기반으로 과부하, 메모리 부족, 디스크 부족 등을 감지하고
 * 알림을 발송함. 냉각 기간을 적용하여 과도한 알림을 방지함.
 */
export const monitorAlerts = async () => {
  const devices = await getDb().all(
    'SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage FROM devices d LEFT JOIN device_metrics_latest m ON m.device_id = d.id ORDER BY d.id DESC',
  )

  const alerts = devices.flatMap((device: any) => evaluateAlerts(device))

  // 냉각 기간 적용
  const now = Date.now()
  const filteredAlerts = alerts.filter((alert: any) => {
    const key = `${alert.deviceId}-${alert.metric}`
    const lastTimestamp = lastAlertTimestamps.get(key) || 0
    if (now - lastTimestamp > ALERT_COOLDOWN_MS) {
      lastAlertTimestamps.set(key, now)
      return true
    }
    return false
  })

  if (filteredAlerts.length) {
    await saveAlertsToDb(filteredAlerts)
    await notifyAlerts(filteredAlerts)
  }
}
