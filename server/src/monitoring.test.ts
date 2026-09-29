import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
delete process.env.DISCORD_WEBHOOK_URL
delete process.env.SLACK_WEBHOOK_URL
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const { closePool, initPool, withTransaction } = await import('./database/index.js')
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

test('queued heartbeat remains ONLINE when offline monitoring runs after it', async () => {
  const staleTime = new Date(Date.now() - 60_000).toISOString()
  const heartbeatTime = new Date().toISOString()
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['Race device', 'AA:BB:CC:DD:EE:01', '192.168.1.20', staleTime, 'ONLINE', staleTime],
  )

  let releaseBlocker!: () => void
  let markBlockerEntered!: () => void
  const blockerEntered = new Promise<void>((resolve) => { markBlockerEntered = resolve })
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve })
  const blocker = withTransaction(async () => {
    markBlockerEntered()
    await blockerGate
  })
  await blockerEntered

  const heartbeat = withTransaction(async (tx) => {
    await tx.run(
      'UPDATE devices SET last_seen = ?, status = ?, updated_at = ? WHERE id = ?',
      [heartbeatTime, 'ONLINE', heartbeatTime, result.lastID],
    )
  })

  const originalAll = db.all
  let monitorReadStarted = false
  let markMonitorReadComplete!: () => void
  const monitorReadComplete = new Promise<void>((resolve) => { markMonitorReadComplete = resolve })
  db.all = async (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('SELECT * FROM devices WHERE status IN')) {
      monitorReadStarted = true
    }
    const rows = await originalAll.apply(db, args)
    if (typeof args[0] === 'string' && args[0].startsWith('SELECT * FROM devices WHERE status IN')) {
      markMonitorReadComplete()
    }
    return rows
  }

  try {
    const monitoring = updateOfflineStates()
    if (monitorReadStarted) await monitorReadComplete
    releaseBlocker()
    await Promise.all([blocker, heartbeat, monitoring])
  } finally {
    db.all = originalAll
    releaseBlocker()
  }

  const device = await db.get('SELECT status, last_seen FROM devices WHERE id = ?', [result.lastID])
  assert.deepEqual(device, { status: 'ONLINE', last_seen: heartbeatTime })
})
