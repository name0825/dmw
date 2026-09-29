import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-restart-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken } = await import('./auth.js')
const { registerDeviceRoutes } = await import('./routes/devices.js')
const { registerAgentRoutes } = await import('./routes/agent.js')
const { registerPairingRoutes } = await import('./routes/pairing.js')

const startServer = async () => {
  await initPool()
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerDeviceRoutes(app)
  registerAgentRoutes(app)
  registerPairingRoutes(app)
  return app
}

const stopServer = async (app: Awaited<ReturnType<typeof startServer>>) => {
  await app.close()
  await closePool()
}

const adminAuthHeader = async () => {
  const admin = await getDb().get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  return { authorization: `Bearer ${createToken(ADMIN_EMAIL, admin.token_version ?? 0)}` }
}

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('devices, pairing, and latest metrics survive a server restart on the same database file', async () => {
  const firstServer = await startServer()
  let manualDeviceId: number
  let pairedDeviceId: number
  let apiKey: string
  try {
    const headers = await adminAuthHeader()

    const createResponse = await firstServer.inject({
      method: 'POST',
      url: '/devices',
      headers,
      payload: { name: 'Manual PC', mac_address: 'AA:BB:CC:DD:EE:31', ip_address: '192.168.1.81' },
    })
    assert.equal(createResponse.statusCode, 201)
    manualDeviceId = createResponse.json().deviceId

    const codeResponse = await firstServer.inject({ method: 'POST', url: '/pairing-codes', headers })
    assert.equal(codeResponse.statusCode, 201)
    const pairResponse = await firstServer.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: codeResponse.json().code, macAddress: 'AA:BB:CC:DD:EE:32', ipAddress: '192.168.1.82' },
    })
    assert.equal(pairResponse.statusCode, 200)
    pairedDeviceId = pairResponse.json().deviceId
    apiKey = pairResponse.json().apiKey

    const heartbeatResponse = await firstServer.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 37, memoryUsage: 48, diskUsage: 59 },
    })
    assert.equal(heartbeatResponse.statusCode, 200)
  } finally {
    await stopServer(firstServer)
  }

  const secondServer = await startServer()
  try {
    const listResponse = await secondServer.inject({
      method: 'GET',
      url: '/devices',
      headers: await adminAuthHeader(),
    })
    assert.equal(listResponse.statusCode, 200)
    const devices = listResponse.json().devices as any[]

    const manual = devices.find((device) => device.id === manualDeviceId)
    assert.equal(manual?.name, 'Manual PC')
    assert.equal(manual?.mac_address, 'AA:BB:CC:DD:EE:31')

    const paired = devices.find((device) => device.id === pairedDeviceId)
    assert.equal(paired?.agent_paired, 1)
    assert.equal(paired?.status, 'ONLINE')
    assert.equal(paired?.cpu_usage, 37)
    assert.equal(paired?.memory_usage, 48)
    assert.equal(paired?.disk_usage, 59)

    const heartbeatAfterRestart = await secondServer.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 10, memoryUsage: 20, diskUsage: 30 },
    })
    assert.equal(heartbeatAfterRestart.statusCode, 200)
  } finally {
    await stopServer(secondServer)
  }
})
