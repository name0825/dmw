import { db } from './db.js'
import { evaluateAlerts, notifyAlerts } from './alerts.js'
import { broadcastState } from './ws.js'
import { evaluateDeviceStatus } from './deviceStatus.js'

// Simple debounce mechanism to prevent spam alerts
const lastAlertTimestamps = new Map<string, number>();

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
  
  // Filter out alerts that are too frequent (debounce)
  const now = Date.now();
  const filteredAlerts = alerts.filter(alert => {
    const key = `${alert.deviceId}-${alert.metric}`;
    const lastTimestamp = lastAlertTimestamps.get(key) || 0;
    const cooldownPeriod = 5 * 60 * 1000; // 5 minutes cooldown
    if (now - lastTimestamp > cooldownPeriod) {
      lastAlertTimestamps.set(key, now);
      return true;
    }
    return false;
  });
  
  if (filteredAlerts.length) {
    await notifyAlerts(filteredAlerts)
  }
}
