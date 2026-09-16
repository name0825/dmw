import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-wake-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken } = await import('./auth.js')
const { registerDeviceRoutes } = await import('./routes/devices.js')

// NOTE on mocking sendWakePacket (server/src/services/wake.ts):
// It is imported as a plain named ESM export with no dependency-injection seam,
// and the compiled output is genuine ESM (package.json "type": "module"), so its
// binding is non-writable/non-configurable and cannot be reassigned from another
// module. Node's built-in `mock.module()` could replace it, but that API requires
// the `--experimental-test-module-mocks` flag, which cannot be passed through the
// fixed `npm test` script (`node --test dist/**/*.test.js`) without editing
// package.json (out of scope). Per the task instructions, this is reported rather
// than changing source. Instead:
// - the "success" cases below exercise the real (fast, ~300ms, local-only UDP
//   broadcast) sendWakePacket, same as the existing wake*.test.ts files do for
//   their rejection cases.
// - the "send failure" case uses a device row with a MAC address that bypasses
//   API-level validation (inserted directly into the DB), which makes the
//   underlying wake_on_lan library reject synchronously before any socket I/O —
//   a deterministic failure with no dependency on real network conditions.

const buildApp = () => {
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerDeviceRoutes(app)
  return app
}

const adminAuthHeader = async () => {
  const db = getDb()
  const admin = await db.get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  return { authorization: `Bearer ${createToken(ADMIN_EMAIL, admin.token_version ?? 0)}` }
}

beforeEach(async () => {
  await initPool()
  await getDb().exec('DELETE FROM devices;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('waking a paired device sends the WOL packet and moves it to WAKE_TIMEOUT', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_paired, status) VALUES (?, ?, ?, 1, ?)',
      ['Paired Device', 'AA:BB:CC:DD:EE:10', '127.0.0.60', 'OFFLINE'],
    )

    const response = await app.inject({
      method: 'POST',
      url: `/devices/${inserted.lastID}/wake`,
      headers: await adminAuthHeader(),
    })
    assert.equal(response.statusCode, 200)

    const row = await db.get('SELECT status FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row.status, 'WAKE_TIMEOUT')
  } finally {
    await app.close()
  }
})

test('waking an unpaired device sends the WOL packet but leaves status untouched and reports agentPaired: false', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_paired, status) VALUES (?, ?, ?, 0, ?)',
      ['Unpaired Device', 'AA:BB:CC:DD:EE:11', '127.0.0.61', 'NOT_PAIRED'],
    )

    const response = await app.inject({
      method: 'POST',
      url: `/devices/${inserted.lastID}/wake`,
      headers: await adminAuthHeader(),
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().agentPaired, false)

    const row = await db.get('SELECT status FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row.status, 'NOT_PAIRED')
  } finally {
    await app.close()
  }
})

test('a WOL send failure returns 502 and leaves the device status unchanged', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_paired, status) VALUES (?, ?, ?, 1, ?)',
      // Malformed MAC, bypassing API-level validation via a direct DB insert,
      // makes wake_on_lan reject synchronously before any packet is sent.
      ['Broken MAC Device', 'not-a-mac-address', '127.0.0.62', 'OFFLINE'],
    )

    const response = await app.inject({
      method: 'POST',
      url: `/devices/${inserted.lastID}/wake`,
      headers: await adminAuthHeader(),
    })
    assert.equal(response.statusCode, 502)

    const row = await db.get('SELECT status FROM devices WHERE id = ?', [inserted.lastID])
    assert.equal(row.status, 'OFFLINE')
  } finally {
    await app.close()
  }
})

test('waking a device missing a MAC or IP address returns 422', async () => {
  const app = buildApp()
  try {
    const db = getDb()
    const inserted = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_paired, status) VALUES (?, ?, ?, 1, ?)',
      ['No Address Device', '', '', 'OFFLINE'],
    )

    const response = await app.inject({
      method: 'POST',
      url: `/devices/${inserted.lastID}/wake`,
      headers: await adminAuthHeader(),
    })
    assert.equal(response.statusCode, 422)
  } finally {
    await app.close()
  }
})
