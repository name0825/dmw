import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { WebSocket } from 'ws'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-realtime-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')
process.env.PORT = String(10_000 + (process.pid % 20_000))
process.env.WS_PORT = String(Number(process.env.PORT) + 1)

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL, WS_PORT } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken } = await import('./auth.js')
const { registerAgentRoutes } = await import('./routes/agent.js')
const { registerPairingRoutes } = await import('./routes/pairing.js')
const { setupWebSocket, closeWebSocket } = await import('./services/ws.js')

const app = Fastify()
app.addHook('preHandler', async (request: any, reply: any) => {
  if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
})
registerAgentRoutes(app)
registerPairingRoutes(app)

before(async () => {
  await initPool()
  setupWebSocket()
})

after(async () => {
  await app.close()
  await closeWebSocket()
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('a heartbeat is pushed to an authenticated WebSocket client with the new metrics', async () => {
  const admin = await getDb().get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  const token = createToken(ADMIN_EMAIL, admin.token_version ?? 0)

  const codeResponse = await app.inject({
    method: 'POST',
    url: '/pairing-codes',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(codeResponse.statusCode, 201)
  const pairResponse = await app.inject({
    method: 'POST',
    url: '/agent/pair',
    payload: { pairingCode: codeResponse.json().code, macAddress: 'AA:BB:CC:DD:EE:41', ipAddress: '192.168.1.91' },
  })
  assert.equal(pairResponse.statusCode, 200)
  const { apiKey, deviceId } = pairResponse.json()

  const client = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, token)
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })

  const update = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no devices-updated message received')), 5000)
    client.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      const device = message.devices?.find((entry: any) => entry.id === deviceId)
      if (message.type === 'devices-updated' && device?.cpu_usage === 73) {
        clearTimeout(timer)
        resolve(device)
      }
    })
  })

  try {
    const heartbeatResponse = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 73, memoryUsage: 61, diskUsage: 45 },
    })
    assert.equal(heartbeatResponse.statusCode, 200)

    const device = await update
    assert.equal(device.status, 'ONLINE')
    assert.equal(device.memory_usage, 61)
    assert.equal(device.disk_usage, 45)
    assert.equal(device.agent_key_hash, undefined)
  } finally {
    client.close()
  }
})
