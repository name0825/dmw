import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-agent-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { API_KEY_HINT_LEN } = await import('./services/agent.js')
const { updateOfflineStates } = await import('./services/monitoring.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute } = await import('./auth.js')
const { registerAgentRoutes } = await import('./routes/agent.js')

const buildApp = () => {
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerAgentRoutes(app)
  return app
}

const seedPairedDevice = async (apiKey: string, overrides: Record<string, unknown> = {}) => {
  const db = getDb()
  const now = new Date().toISOString()
  const lastSeen = (overrides.last_seen as string | undefined) ?? now
  const status = (overrides.status as string | undefined) ?? 'ONLINE'
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, agent_paired, paired_at, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    ['Agent Device', 'AA:BB:CC:DD:EE:20', '192.168.1.70', await bcrypt.hash(apiKey, 10), apiKey.slice(0, API_KEY_HINT_LEN), now, lastSeen, status, lastSeen],
  )
  return result.lastID as number
}

beforeEach(async () => {
  await initPool()
  await getDb().exec('DELETE FROM devices; DELETE FROM device_metrics_latest; DELETE FROM device_metrics_history;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('a heartbeat with a valid API key is accepted', async () => {
  const app = buildApp()
  try {
    const apiKey = 'valid-agent-key-1234567890'
    await seedPairedDevice(apiKey)

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('a heartbeat with a wrong API key is rejected', async () => {
  const app = buildApp()
  try {
    await seedPairedDevice('the-real-agent-key-1234567')

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: 'Bearer the-wrong-agent-key-98765' },
    })
    assert.equal(response.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('a heartbeat stores CPU, memory, and disk usage', async () => {
  const app = buildApp()
  try {
    const apiKey = 'metrics-agent-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 42, memoryUsage: 55, diskUsage: 60 },
    })
    assert.equal(response.statusCode, 200)

    const metrics = await getDb().get(
      'SELECT cpu_usage, memory_usage, disk_usage FROM device_metrics_latest WHERE device_id = ?',
      [deviceId],
    )
    assert.deepEqual(metrics, { cpu_usage: 42, memory_usage: 55, disk_usage: 60 })
  } finally {
    await app.close()
  }
})

test('a device goes OFFLINE after more than 30 seconds without a heartbeat, then recovers to ONLINE on the next heartbeat', async () => {
  const app = buildApp()
  try {
    const apiKey = 'timeout-agent-key-1234567890'
    const staleTimestamp = new Date(Date.now() - 31_000).toISOString()
    const deviceId = await seedPairedDevice(apiKey, { last_seen: staleTimestamp, status: 'ONLINE' })

    await updateOfflineStates()

    const offlineRow = await getDb().get('SELECT status FROM devices WHERE id = ?', [deviceId])
    assert.equal(offlineRow.status, 'OFFLINE')

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.statusCode, 200)

    const onlineRow = await getDb().get('SELECT status FROM devices WHERE id = ?', [deviceId])
    assert.equal(onlineRow.status, 'ONLINE')
  } finally {
    await app.close()
  }
})
