import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
delete process.env.DISCORD_WEBHOOK_URL
delete process.env.SLACK_WEBHOOK_URL
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const { closePool, initPool } = await import('./database/index.js')
const { monitorAlerts } = await import('./services/monitoring.js')
const db = await initPool()

after(async () => closePool())

const seedDevice = async (mac: string, status: string, paired: number) => {
  const now = new Date().toISOString()
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, agent_paired, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['device', mac, '192.168.1.10', paired, now, status, now],
  )
  await db.run(
    'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage, updated_at) VALUES (?, 99, 99, 99, ?)',
    [result.lastID, now],
  )
  return result.lastID as number
}

const alertCount = async (deviceId: number) =>
  (await db.get('SELECT COUNT(*) AS count FROM alerts WHERE device_id = ?', [deviceId])).count

test('monitorAlerts does not alert for an offline device with stale metrics', async () => {
  const deviceId = await seedDevice('AA:BB:CC:00:00:01', 'OFFLINE', 1)
  await monitorAlerts()
  assert.equal(await alertCount(deviceId), 0)
})

test('monitorAlerts does not alert for an unpaired device with leftover metrics', async () => {
  const deviceId = await seedDevice('AA:BB:CC:00:00:02', 'ONLINE', 0)
  await monitorAlerts()
  assert.equal(await alertCount(deviceId), 0)
})

test('monitorAlerts alerts for an online paired device over thresholds', async () => {
  const deviceId = await seedDevice('AA:BB:CC:00:00:03', 'ONLINE', 1)
  await monitorAlerts()
  assert.equal(await alertCount(deviceId), 3)
})
