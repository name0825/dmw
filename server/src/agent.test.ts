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

const seedPairingCode = async (code: string, targetDeviceId: number | null = null) => {
  await getDb().run(
    'INSERT INTO pairing_codes (code, expires_at, target_device_id) VALUES (?, ?, ?)',
    [code, new Date(Date.now() + 60_000).toISOString(), targetDeviceId],
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

test('unpair removes the latest metrics row of the device', async () => {
  const apiKey = 'metrics-agent-key-1234567890'
  const deviceId = await seedPairedDevice(apiKey)
  await getDb().run(
    'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage) VALUES (?, 99, 99, 99)',
    [deviceId],
  )

  const unpairReply = reply()
  await handleUnpair(request(apiKey), unpairReply)
  assert.equal(unpairReply.status, 200)

  const row = await getDb().get('SELECT device_id FROM device_metrics_latest WHERE device_id = ?', [deviceId])
  assert.equal(row, undefined)
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
  const deviceId = await seedPairedDevice(oldKey)
  await seedPairingCode('re-pair-code', deviceId)

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

test('a new-device pairing code cannot re-key an already-paired device by MAC', async () => {
  const oldKey = 'already-paired-key-123456'
  const deviceId = await seedPairedDevice(oldKey)
  const before = await getDb().get('SELECT agent_key_hash FROM devices WHERE id = ?', [deviceId])
  await seedPairingCode('new-device-code')

  const pairReply = reply()
  await handlePair(
    { body: { pairingCode: 'new-device-code', macAddress: 'AA:BB:CC:DD:EE:FF', ipAddress: '192.168.1.11' } },
    pairReply,
  )
  assert.equal(pairReply.status, 409)

  const after = await getDb().get('SELECT agent_key_hash FROM devices WHERE id = ?', [deviceId])
  assert.equal(after.agent_key_hash, before.agent_key_hash)

  const code = await getDb().get('SELECT used_at FROM pairing_codes WHERE code = ?', ['new-device-code'])
  assert.equal(code.used_at, null)
})

test('a pairing code targeted at a device succeeds when the MAC matches and rotates the key', async () => {
  const oldKey = 'target-match-key-1234567'
  const deviceId = await seedPairedDevice(oldKey)
  await seedPairingCode('targeted-code', deviceId)

  const pairReply = reply()
  await handlePair(
    { body: { pairingCode: 'targeted-code', macAddress: 'AA:BB:CC:DD:EE:FF', ipAddress: '192.168.1.12' } },
    pairReply,
  )
  assert.equal(pairReply.status, 200)
  assert.equal((pairReply.body as { deviceId: number }).deviceId, deviceId)

  const newKey = (pairReply.body as { apiKey: string }).apiKey
  const device = await getDb().get('SELECT agent_key_hash FROM devices WHERE id = ?', [deviceId])
  assert.ok(await bcrypt.compare(newKey, device.agent_key_hash))
})

test('a pairing code targeted at a device is rejected when the reported MAC does not match', async () => {
  const oldKey = 'target-mismatch-key-12345'
  const deviceId = await seedPairedDevice(oldKey)
  await seedPairingCode('targeted-mismatch-code', deviceId)

  const pairReply = reply()
  await handlePair(
    { body: { pairingCode: 'targeted-mismatch-code', macAddress: '11:22:33:44:55:66', ipAddress: '192.168.1.13' } },
    pairReply,
  )
  assert.equal(pairReply.status, 409)

  const code = await getDb().get('SELECT used_at FROM pairing_codes WHERE code = ?', ['targeted-mismatch-code'])
  assert.equal(code.used_at, null)
})

test('a new-device pairing code adopts an existing unpaired device row instead of duplicating it', async () => {
  const db = getDb()
  const now = new Date().toISOString()
  const insertResult = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Manual Device', '11:22:33:44:55:77', '192.168.1.14', 'NOT_PAIRED', now],
  )
  const deviceId = insertResult.lastID as number
  await seedPairingCode('adopt-code')

  const pairReply = reply()
  await handlePair(
    { body: { pairingCode: 'adopt-code', macAddress: '11:22:33:44:55:77', ipAddress: '192.168.1.15' } },
    pairReply,
  )
  assert.equal(pairReply.status, 200)
  assert.equal((pairReply.body as { deviceId: number }).deviceId, deviceId)

  const rows = await db.all('SELECT id FROM devices WHERE mac_address = ?', ['11:22:33:44:55:77'])
  assert.equal(rows.length, 1)

  const device = await db.get('SELECT agent_paired, name FROM devices WHERE id = ?', [deviceId])
  assert.equal(device.agent_paired, 1)
  assert.equal(device.name, 'Manual Device')
})
