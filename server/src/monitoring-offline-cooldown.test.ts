import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
delete process.env.DISCORD_WEBHOOK_URL
delete process.env.SLACK_WEBHOOK_URL
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const { closePool, initPool } = await import('./database/index.js')
const { updateOfflineStates } = await import('./services/monitoring.js')
const db = await initPool()

after(async () => closePool())

const STALE = '2000-01-01T00:00:00.000Z'

const offlineAlertCount = async (deviceId: number) =>
  (await db.get("SELECT COUNT(*) AS count FROM alerts WHERE device_id = ? AND metric = 'offline'", [deviceId])).count

test('offline alert is suppressed by the cooldown when a device flaps ONLINE -> OFFLINE again', async () => {
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['flappy', 'AA:BB:CC:00:10:01', '192.168.1.50', STALE, 'ONLINE', STALE],
  )
  const deviceId = result.lastID as number

  await updateOfflineStates()
  assert.equal(await offlineAlertCount(deviceId), 1)

  await db.run('UPDATE devices SET status = ?, last_seen = ?, updated_at = ? WHERE id = ?', ['ONLINE', STALE, STALE, deviceId])
  await updateOfflineStates()
  assert.equal(await offlineAlertCount(deviceId), 1)
})

test('WAKE_TIMEOUT -> OFFLINE does not raise an offline alert', async () => {
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['waking', 'AA:BB:CC:00:10:02', '192.168.1.51', STALE, 'WAKE_TIMEOUT', STALE],
  )
  const deviceId = result.lastID as number

  await updateOfflineStates()
  assert.equal((await db.get('SELECT status FROM devices WHERE id = ?', [deviceId])).status, 'OFFLINE')
  assert.equal(await offlineAlertCount(deviceId), 0)
})
