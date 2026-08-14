import { db } from './db.js'
import { evaluateAlerts, notifyAlerts } from './alerts.js'
import { broadcastState } from './ws.js'
import { evaluateDeviceStatus } from './deviceStatus.js'

export const updateOfflineStates = async () => {
  const devices = await db.all('SELECT * FROM devices WHERE status IN (?, ?, ?) ORDER BY id DESC', ['ONLINE', 'OFFLINE', 'WAKE_TIMEOUT'])

  for (const device of devices) {
    const nextStatus = evaluateDeviceStatus(device, new Date())
    if (nextStatus !== device.status) {
      await db.run('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?', [nextStatus, new Date().toISOString(), device.id])
    }
  }

  await broadcastState()
}

export const monitorAlerts = async () => {
  const devices = await db.all(`
    SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage
    FROM devices d
    LEFT JOIN device_metrics_latest m ON m.device_id = d.id
    ORDER BY d.id DESC
  `)

  const alerts = devices.flatMap((device: any) => evaluateAlerts(device))
  if (alerts.length) {
    await notifyAlerts(alerts)
  }
}
