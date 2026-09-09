import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-agent-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { API_KEY_HINT_LEN, handleHeartbeat, handlePair, handleUnpair } = await import('./services/agent.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute } = await import('./auth.js')
const { registerAgentRoutes } = await import('./routes/agent.js')

type Reply = {
  status: number
  body?: unknown
  code: (status: number) => Reply
  send: (body: unknown) => Reply
}

const reply = (): Reply => ({
  status: 200,
  code(status) {
    this.status = status
    return this
  },
  send(body) {
    this.body = body
    return this
  },
})

const request = (apiKey: string, body?: unknown) => ({
  headers: { authorization: `Bearer ${apiKey}` },
  body,
})

const seedPairedDevice = async (apiKey: string) => {
  const db = getDb()
  const now = new Date().toISOString()
  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, agent_paired, paired_at, last_seen, status, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    ['Agent', 'AA:BB:CC:DD:EE:FF', '192.168.1.10', await bcrypt.hash(apiKey, 10), apiKey.slice(0, API_KEY_HINT_LEN), now, now, 'ONLINE', now],
  )
  return result.lastID as number
}

const seedPairingCode = async (code: string) => {
  await getDb().run(
    'INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)',
    [code, new Date(Date.now() + 60_000).toISOString()],
  )
}

beforeEach(async () => {
  const db = await initPool()
  await db.exec('DELETE FROM pairing_codes; DELETE FROM devices;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('unpair revokes the key and rejects every later heartbeat', async () => {
  const apiKey = 'old-agent-key-1234567890'
  const deviceId = await seedPairedDevice(apiKey)

  const unpairReply = reply()
  await handleUnpair(request(apiKey), unpairReply)
  assert.equal(unpairReply.status, 200)
  assert.deepEqual(unpairReply.body, { status: 'ok' })

  const device = await getDb().get('SELECT agent_key_hash, agent_key_hint, agent_paired, paired_at, last_seen, status FROM devices WHERE id = ?', [deviceId])
  assert.deepEqual(device, {
    agent_key_hash: null,
    agent_key_hint: null,
    agent_paired: 0,
    paired_at: null,
    last_seen: null,
    status: 'NOT_PAIRED',
  })

  const heartbeatReply = reply()
  await handleHeartbeat(request(apiKey, { cpuUsage: 50 }), heartbeatReply)
  assert.equal(heartbeatReply.status, 401)
  assert.deepEqual(heartbeatReply.body, { message: 'Invalid or missing API key' })
})

test('unpair bypasses global JWT middleware but still requires the agent API key', async () => {
  const apiKey = 'fastify-agent-key-123456'
  await seedPairedDevice(apiKey)
  const app = Fastify()
  app.addHook('preHandler', async (incoming: any, outgoing) => {
    if (!isPublicRoute(incoming.url)) await authMiddleware(incoming, outgoing)
  })
  registerAgentRoutes(app)
  try {
    const response = await app.inject({ method: 'POST', url: '/agent/unpair?from=agent', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('an old unpair racing a re-pair cannot revoke the replacement key', async () => {
  const oldKey = 'old-agent-key-1234567890'
  await seedPairedDevice(oldKey)
  await seedPairingCode('re-pair-code')

  const unpairReply = reply()
  const pairReply = reply()
  await Promise.all([
    handleUnpair(request(oldKey), unpairReply),
    handlePair({ body: { pairingCode: 're-pair-code', macAddress: 'AA:BB:CC:DD:EE:FF', ipAddress: '192.168.1.11' } }, pairReply),
  ])

  assert.equal(pairReply.status, 200)
  const newKey = (pairReply.body as { apiKey: string }).apiKey
  assert.equal(typeof newKey, 'string')

  const newHeartbeatReply = reply()
  await handleHeartbeat(request(newKey, { memoryUsage: 30 }), newHeartbeatReply)
  assert.equal(newHeartbeatReply.status, 200)
  assert.deepEqual(newHeartbeatReply.body, { status: 'ok' })

  const oldHeartbeatReply = reply()
  await handleHeartbeat(request(oldKey), oldHeartbeatReply)
  assert.equal(oldHeartbeatReply.status, 401)
})
