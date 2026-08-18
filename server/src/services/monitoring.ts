import { getDb } from '../database/index.js'
import { evaluateAlerts, notifyAlerts } from './alerts.js'
import { broadcastState } from './ws.js'
import { evaluateDeviceStatus } from './deviceStatus.js'

/**
 * 기기 상태 업데이트 및 오프라인 상태 관리.
 * 백그라운드에서 주기적으로 실행되며, last_seen 와 updated_at 를 기반으로
 * 기기 상태를 평가하고 DB 에 갱신함.
 */
export const updateOfflineStates = async () => {
  const devices = await getDb().all(
    'SELECT * FROM devices WHERE status IN (?, ?, ?) ORDER BY id DESC',
    ['ONLINE', 'OFFLINE', 'WAKE_TIMEOUT'],
  )

  for (const device of devices) {
    const nextStatus = evaluateDeviceStatus(device, new Date())
    if (nextStatus !== device.status) {
      await getDb().run(
        'UPDATE devices SET status = ?, updated_at = ? WHERE id = ?',
        [nextStatus, new Date().toISOString(), device.id],
      )
    }
  }

  await broadcastState()
}

/**
 * 알람 평가 및 알림 발송.
 * 기기 메트릭스를 기반으로 과부하, 메모리 부족, 디스크 부족 등을 감지하고
 * 알림을 발송함. 5 분 냉각 기간을 적용하여 과도한 알림을 방지함.
 */
export const monitorAlerts = async () => {
  const devices = await getDb().all(
    'SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage FROM devices d LEFT JOIN device_metrics_latest m ON m.device_id = d.id ORDER BY d.id DESC',
  )

  const alerts = devices.flatMap((device: any) => evaluateAlerts(device))

  // 5 분 냉각 기간 적용
  const now = Date.now()
  const filteredAlerts = alerts.filter((alert: any) => {
    const key = `${alert.deviceId}-${alert.metric}`
    const lastTimestamp = ({} as any).lastAlertTimestamps?.get(key) || 0
    const cooldownPeriod = 5 * 60 * 1000
    if (now - lastTimestamp > cooldownPeriod) {
      return true
    }
    return false
  })

  if (filteredAlerts.length) {
    await notifyAlerts(filteredAlerts)
  }
}
