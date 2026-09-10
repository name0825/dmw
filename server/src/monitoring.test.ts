import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'

const { initPool, closePool, getDb, withTransaction } = await import('./database/index.js')
const { updateOfflineStates } = await import('./services/monitoring.js')

beforeEach(async () => {
  const db = await initPool()
  await db.exec('DELETE FROM devices;')
})

after(async () => {
  await closePool()
})

test('queued heartbeat remains ONLINE when offline monitoring runs after it', async () => {
  const db = getDb()
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
