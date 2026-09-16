import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-devices-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken } = await import('./auth.js')
const { registerDeviceRoutes } = await import('./routes/devices.js')
const { registerAgentRoutes } = await import('./routes/agent.js')
const { registerPairingRoutes } = await import('./routes/pairing.js')

const buildApp = () => {
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerDeviceRoutes(app)
  registerAgentRoutes(app)
  registerPairingRoutes(app)
  return app
}

const adminAuthHeader = async () => {
  const db = getDb()
  const admin = await db.get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  return { authorization: `Bearer ${createToken(ADMIN_EMAIL, admin.token_version ?? 0)}` }
}

beforeEach(async () => {
  await initPool()
  const db = getDb()
  await db.exec('DELETE FROM pairing_codes; DELETE FROM devices;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('a device can be created', async () => {
  const app = buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      headers: await adminAuthHeader(),
      payload: { name: 'Living Room PC', mac_address: 'AA:BB:CC:DD:EE:01', ip_address: '192.168.1.50' },
    })
    assert.equal(response.statusCode, 201)
    assert.ok(response.json().deviceId)

    const db = getDb()
    const row = await db.get('SELECT name, mac_address, ip_address FROM devices WHERE id = ?', [response.json().deviceId])
    assert.deepEqual(row, { name: 'Living Room PC', mac_address: 'AA:BB:CC:DD:EE:01', ip_address: '192.168.1.50' })
  } finally {
    await app.close()
  }
})

test('a pairing code is issued on request and a device pairs with it, receiving an API key', async () => {
  const app = buildApp()
  try {
    const codeResponse = await app.inject({
      method: 'POST',
      url: '/pairing-codes',
      headers: await adminAuthHeader(),
    })
    assert.equal(codeResponse.statusCode, 201)
    const { code } = codeResponse.json()
    assert.ok(code)

    const pairResponse = await app.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: code, macAddress: 'AA:BB:CC:DD:EE:02', ipAddress: '192.168.1.51' },
    })
    assert.equal(pairResponse.statusCode, 200)
    assert.ok(pairResponse.json().apiKey)
    assert.ok(pairResponse.json().deviceId)
  } finally {
    await app.close()
  }
})

test('an expired or wrong pairing code is rejected', async () => {
  const app = buildApp()
  try {
    const wrongCodeResponse = await app.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: 'NOTREAL1', macAddress: 'AA:BB:CC:DD:EE:03', ipAddress: '192.168.1.52' },
    })
    assert.equal(wrongCodeResponse.statusCode, 401)

    const db = getDb()
    await db.run(
      'INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)',
      ['EXPIRED1', new Date(Date.now() - 60_000).toISOString()],
    )
    const expiredCodeResponse = await app.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: 'EXPIRED1', macAddress: 'AA:BB:CC:DD:EE:04', ipAddress: '192.168.1.53' },
    })
    assert.equal(expiredCodeResponse.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('a pairing code can only be used once', async () => {
  const app = buildApp()
  try {
    const codeResponse = await app.inject({
      method: 'POST',
      url: '/pairing-codes',
      headers: await adminAuthHeader(),
    })
    const { code } = codeResponse.json()

    const firstUse = await app.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: code, macAddress: 'AA:BB:CC:DD:EE:05', ipAddress: '192.168.1.54' },
    })
    assert.equal(firstUse.statusCode, 200)

    const secondUse = await app.inject({
      method: 'POST',
      url: '/agent/pair',
      payload: { pairingCode: code, macAddress: 'AA:BB:CC:DD:EE:06', ipAddress: '192.168.1.55' },
    })
    assert.equal(secondUse.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('a device can be updated', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
      ['Old Name', 'AA:BB:CC:DD:EE:07', '192.168.1.56', 'NOT_PAIRED'],
    )

    const response = await app.inject({
      method: 'PATCH',
      url: `/devices/${inserted.lastID}`,
      headers: await adminAuthHeader(),
      payload: { name: 'New Name', mac_address: 'AA:BB:CC:DD:EE:07', ip_address: '192.168.1.56' },
    })
    assert.equal(response.statusCode, 200)

    const row = await db.get('SELECT name FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row.name, 'New Name')
  } finally {
    await app.close()
  }
})

test('a device can be deleted', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
      ['To Delete', 'AA:BB:CC:DD:EE:08', '192.168.1.57', 'NOT_PAIRED'],
    )

    const response = await app.inject({
      method: 'DELETE',
      url: `/devices/${inserted.lastID}`,
      headers: await adminAuthHeader(),
    })
    assert.equal(response.statusCode, 200)

    const row = await db.get('SELECT id FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row, undefined)
  } finally {
    await app.close()
  }
})

test('device data persists across the DB pool being closed and reopened on the same file', async () => {
  const app = buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      headers: await adminAuthHeader(),
      payload: { name: 'Persistent Device', mac_address: 'AA:BB:CC:DD:EE:09', ip_address: '192.168.1.58' },
    })
    const deviceId = response.json().deviceId

    // Simulate a server restart: close the pool and reopen the same DB file.
    await closePool()
    await initPool()

    const row = await getDb().get('SELECT name FROM devices WHERE id = ?', [deviceId])
    assert.equal(row.name, 'Persistent Device')
  } finally {
    await app.close()
  }
})
