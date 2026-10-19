import { getDb, withTransaction } from '../database/index.js'
import { evaluateAlerts, evaluateOfflineAlert, type DeviceAlert } from '../alerts.js'
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

/** 이력 정리 실패 시 재시도 간격 — 10 초마다 오는 틱마다 실패한 DB 를 다시 두드리지 않도록 함. */
const HISTORY_PRUNE_RETRY_MS = 5 * 60 * 1000

// 마지막으로 이력 정리가 "성공"한 시각. updateOfflineStates 는 10 초마다 호출되므로,
// 매번 DELETE 를 돌리지 않도록 하루에 한 번 정도만 실행되게 스로틀함.
// 실패 시에는 갱신하지 않되(다음 틱들이 계속 실패로 재시도하지 않도록) HISTORY_PRUNE_RETRY_MS
// 뒤에 한 번 더 시도되도록 앞당겨 둔다.
let lastHistoryPruneAt = 0

// pruneMetricsHistory/pruneAlerts 실행 도중 updateOfflineStates 가 다시 호출되어
// (setInterval 은 이전 호출 완료를 기다리지 않는다) 정리 작업이 겹쳐 실행되는 것을 막는 잠금.
let historyPruneInFlight = false

/**
 * device_metrics_history 에서 보존 기간이 지난 오래된 행을 삭제함.
 */
const pruneMetricsHistory = async () => {
  const cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString()
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM device_metrics_history WHERE timestamp < ?', [cutoff])
  })
}

/**
 * alerts 에서 보존 기간이 지난 오래된 행을 삭제함.
 */
const pruneAlerts = async () => {
  const cutoff = new Date(Date.now() - ALERT_RETENTION_MS).toISOString()
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM alerts WHERE created_at < ?', [cutoff])
  })
}

const applyAlertCooldown = (alerts: DeviceAlert[]): DeviceAlert[] => {
  const now = Date.now()
  const seen = new Set<string>()
  return alerts.filter((alert) => {
    const key = `${alert.deviceId}-${alert.metric}`
    const lastTimestamp = lastAlertTimestamps.get(key) || 0
    if (!seen.has(key) && now - lastTimestamp > ALERT_COOLDOWN_MS) {
      seen.add(key)
      return true
    }
    return false
  })
}

const recordAlertCooldown = (alerts: DeviceAlert[]) => {
  const now = Date.now()
  for (const alert of alerts) {
    lastAlertTimestamps.set(`${alert.deviceId}-${alert.metric}`, now)
  }
}

const updateDeviceStatuses = async (tx: any, now: Date = new Date()) => {
  const devices = await tx.all(
    'SELECT * FROM devices WHERE status IN (?, ?, ?) ORDER BY id DESC',
    [STATUS_ONLINE, STATUS_OFFLINE, STATUS_WAKE_TIMEOUT],
  )
  const transitions: Array<{ device: any; previousStatus: string }> = []

  for (const device of devices) {
    const nextStatus = evaluateDeviceStatus(device, now)
    if (nextStatus !== device.status) {
      await tx.run(
        'UPDATE devices SET status = ?, updated_at = ? WHERE id = ?',
        [nextStatus, now.toISOString(), device.id],
      )
      transitions.push({ device: { ...device, status: nextStatus }, previousStatus: device.status })
    }
  }

  return transitions
}

/**
 * 기기 상태 업데이트 및 오프라인 상태 관리.
 * 백그라운드에서 주기적으로 실행되며, last_seen 와 updated_at 를 기반으로
 * 기기 상태를 평가하고 DB 에 갱신함.
 */
export const updateOfflineStates = async () => {
  const transitions = await withTransaction((tx) => updateDeviceStatuses(tx))
  const offlineAlerts = applyAlertCooldown(transitions.flatMap(({ device, previousStatus }) =>
    evaluateOfflineAlert(device, previousStatus),
  ))
  if (offlineAlerts.length) {
    await saveAlertsToDb(offlineAlerts)
    recordAlertCooldown(offlineAlerts)
    await notifyAlerts(offlineAlerts)
  }

  // 이력·알림 정리는 10 초마다 도는 이 루프에서 매번 DELETE 를 실행하지 않도록
  // 하루에 한 번 정도만 실행되게 스로틀함 (routes.ts 에 별도 스케줄러를 둘 수 없어 여기서 처리).
  if (!historyPruneInFlight && Date.now() - lastHistoryPruneAt > HISTORY_PRUNE_INTERVAL_MS) {
    historyPruneInFlight = true
    try {
      await pruneMetricsHistory()
      await pruneAlerts()
      // 둘 다 성공했을 때만 시각을 갱신한다 — 갱신을 먼저 해두면 실패해도
      // 다음 24 시간 동안 정리가 조용히 건너뛰어진다.
      lastHistoryPruneAt = Date.now()
    } catch (error) {
      // 실패했다고 다음 틱(10 초 뒤)마다 바로 재시도하면 죽어있는 DB 를 계속
      // 두드리게 되므로, 완전히 24 시간을 기다리는 대신 짧게만 미뤄 재시도한다.
      lastHistoryPruneAt = Date.now() - HISTORY_PRUNE_INTERVAL_MS + HISTORY_PRUNE_RETRY_MS
      console.error('Error pruning metrics history/alerts:', error)
    } finally {
      historyPruneInFlight = false
    }
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
    'SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage FROM devices d JOIN device_metrics_latest m ON m.device_id = d.id WHERE d.status = ? AND d.agent_paired = 1 ORDER BY d.id DESC',
    [STATUS_ONLINE],
  )

  const alerts = devices.flatMap((device: any) => evaluateAlerts(device))

  // 냉각 기간 적용
  const filteredAlerts = applyAlertCooldown(alerts)

  if (filteredAlerts.length) {
    await saveAlertsToDb(filteredAlerts)
    recordAlertCooldown(filteredAlerts)
    await notifyAlerts(filteredAlerts)
  }
}
