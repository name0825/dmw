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

test('offline update reads under the transaction and persists one post-commit alert', async () => {
  await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['server', '00:11:22:33:44:55', '127.0.0.1', '2000-01-01T00:00:00.000Z', 'ONLINE', '2000-01-01T00:00:00.000Z'],
  )

  const execute = db.exec.bind(db)
  const queryAll = db.all.bind(db)
  let transactionActive = false
  let statusReadInsideTransaction = false

  db.exec = async (sql: string) => {
    const result = await execute(sql)
    if (sql === 'BEGIN') transactionActive = true
    if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionActive = false
    return result
  }
  db.all = async (sql: string, ...params: unknown[]) => {
    if (sql.startsWith('SELECT * FROM devices WHERE status IN')) {
      statusReadInsideTransaction = transactionActive
    }
    return queryAll(sql, ...params)
  }

  await updateOfflineStates()

  assert.equal(statusReadInsideTransaction, true)
  assert.equal((await db.get('SELECT status FROM devices WHERE id = 1')).status, 'OFFLINE')
  assert.deepEqual(
    await db.all('SELECT device_id, level, metric, value FROM alerts ORDER BY id'),
    [{ device_id: 1, level: 'critical', metric: 'offline', value: 0 }],
  )

  await updateOfflineStates()

  assert.equal((await db.get('SELECT COUNT(*) AS count FROM alerts')).count, 1)
})
