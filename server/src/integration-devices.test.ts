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

test('device create and update reject a missing body or an invalid name', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
      ['Keep Name', 'AA:BB:CC:DD:EE:08', '192.168.1.57', 'NOT_PAIRED'],
    )
    const headers = await adminAuthHeader()
    const base = { mac_address: 'AA:BB:CC:DD:EE:08', ip_address: '192.168.1.57' }
    const payloads: Array<unknown> = [
      undefined,
      { ...base },
      { ...base, name: 123 },
      { ...base, name: '   ' },
      { ...base, name: 'x'.repeat(101) },
    ]

    for (const payload of payloads) {
      const create = await app.inject({ method: 'POST', url: '/devices', headers, payload: payload as any })
      assert.equal(create.statusCode, 400)
      const update = await app.inject({ method: 'PATCH', url: `/devices/${inserted.lastID}`, headers, payload: payload as any })
      assert.equal(update.statusCode, 400)
    }

    const row = await db.get('SELECT name FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row.name, 'Keep Name')
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM devices')).count, 1)

    const trimmed = await app.inject({
      method: 'PATCH',
      url: `/devices/${inserted.lastID}`,
      headers,
      payload: { ...base, name: '  Padded  ' },
    })
    assert.equal(trimmed.statusCode, 200)
    assert.equal((await db.get('SELECT name FROM devices WHERE id = ?', [inserted.lastID])).name, 'Padded')
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

test('PUT /devices/:id/metric-selection validates input, requires auth, persists and is reflected by GET /devices', async () => {
  const app = buildApp()
  try {
    const headers = await adminAuthHeader()
    const created = await app.inject({
      method: 'POST',
      url: '/devices',
      headers,
      payload: { name: 'Selection PC', mac_address: 'AA:BB:CC:DD:EE:31', ip_address: '192.168.1.81' },
    })
    const id = created.json().deviceId

    const unauthorized = await app.inject({ method: 'PUT', url: `/devices/${id}/metric-selection`, payload: { metrics: [] } })
    assert.equal(unauthorized.statusCode, 401)

    for (const payload of [{}, { metrics: 'cpu_usage' }, { metrics: ['cpu_usage', 'bogus'] }, { metrics: [1] }]) {
      const bad = await app.inject({ method: 'PUT', url: `/devices/${id}/metric-selection`, headers, payload })
      assert.equal(bad.statusCode, 400)
    }

    const missing = await app.inject({ method: 'PUT', url: '/devices/999999/metric-selection', headers, payload: { metrics: [] } })
    assert.equal(missing.statusCode, 404)

    const before = await getDb().get('SELECT updated_at FROM devices WHERE id = ?', [id])
    const ok = await app.inject({
      method: 'PUT',
      url: `/devices/${id}/metric-selection`,
      headers,
      payload: { metrics: ['cpu_temp', 'cpu_usage', 'cpu_usage'] },
    })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json(), { metrics: ['cpu_usage', 'cpu_temp'] })
    const after = await getDb().get('SELECT updated_at, metric_selection FROM devices WHERE id = ?', [id])
    assert.equal(after.updated_at, before.updated_at)
    assert.equal(after.metric_selection, JSON.stringify(['cpu_usage', 'cpu_temp']))

    const list = await app.inject({ method: 'GET', url: '/devices', headers })
    assert.deepEqual(list.json().devices[0].metric_selection, ['cpu_usage', 'cpu_temp'])

    const empty = await app.inject({ method: 'PUT', url: `/devices/${id}/metric-selection`, headers, payload: { metrics: [] } })
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), { metrics: [] })
  } finally {
    await app.close()
  }
})

test('device write routes reject a non-admin user with 403', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    await db.run('DELETE FROM users WHERE email = ?', ['plain-user@dmw.local'])
    await db.run('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)', [
      'plain-user@dmw.local',
      'x',
      'user',
      new Date().toISOString(),
    ])
    const headers = { authorization: `Bearer ${createToken('plain-user@dmw.local', 0)}` }
    const created = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Target', 'AA:BB:CC:DD:EE:31', '192.168.1.71', 'OFFLINE', new Date().toISOString()],
    )
    const id = created.lastID

    const attempts = [
      { method: 'POST', url: '/devices', payload: { name: 'X', mac_address: 'AA:BB:CC:DD:EE:32', ip_address: '192.168.1.72' } },
      { method: 'PATCH', url: `/devices/${id}`, payload: { name: 'Y' } },
      { method: 'PUT', url: `/devices/${id}/metric-selection`, payload: { metrics: [] } },
      { method: 'POST', url: `/devices/${id}/wake` },
      { method: 'DELETE', url: `/devices/${id}` },
    ] as const
    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers })
      assert.equal(response.statusCode, 403, `${attempt.method} ${attempt.url}`)
    }
    assert.ok(await db.get('SELECT 1 FROM devices WHERE id = ?', [id]))

    const read = await app.inject({ method: 'GET', url: '/devices', headers })
    assert.equal(read.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('POST /pairing-codes rejects a non-admin user with 403', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    await db.run('DELETE FROM users WHERE email = ?', ['plain-user2@dmw.local'])
    await db.run('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)', [
      'plain-user2@dmw.local',
      'x',
      'user',
      new Date().toISOString(),
    ])
    const response = await app.inject({
      method: 'POST',
      url: '/pairing-codes',
      headers: { authorization: `Bearer ${createToken('plain-user2@dmw.local', 0)}` },
      payload: {},
    })
    assert.equal(response.statusCode, 403)
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pairing_codes')).n, 0)
  } finally {
    await app.close()
  }
})
