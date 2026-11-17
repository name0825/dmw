import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-agent-update-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { API_KEY_HINT_LEN } = await import('./services/agent.js')
const { ADMIN_EMAIL } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken } = await import('./auth.js')
const { registerAgentRoutes } = await import('./routes/agent.js')
const { registerDeviceRoutes } = await import('./routes/devices.js')

const buildApp = () => {
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerDeviceRoutes(app)
  registerAgentRoutes(app)
  return app
}

const adminAuthHeader = async () => {
  const admin = await getDb().get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  return { authorization: `Bearer ${createToken(ADMIN_EMAIL, admin.token_version ?? 0)}` }
}

const seedDevice = async (apiKey: string, { paired = true, version = '1.0.0' } = {}) => {
  const now = new Date().toISOString()
  const result = await getDb().run(
    'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, agent_paired, paired_at, last_seen, status, agent_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['Agent Device', 'AA:BB:CC:DD:EE:30', '192.168.1.80', await bcrypt.hash(apiKey, 10), apiKey.slice(0, API_KEY_HINT_LEN), paired ? 1 : 0, now, now, 'ONLINE', version, now],
  )
  return result.lastID as number
}

const heartbeat = (app: any, apiKey: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: `Bearer ${apiKey}` }, payload })

const requestUpdate = async (app: any, id: number) =>
  app.inject({ method: 'POST', url: `/devices/${id}/agent-update`, headers: await adminAuthHeader() })

const updateRow = (id: number) =>
  getDb().get('SELECT update_state, update_message, agent_version FROM devices WHERE id = ?', [id])

beforeEach(async () => {
  await initPool()
  await getDb().exec('DELETE FROM devices; DELETE FROM device_metrics_latest; DELETE FROM device_metrics_history;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('an update request is delivered exactly once on the next heartbeat', async () => {
  const app = buildApp()
  try {
    const apiKey = 'update-flow-key-1234567890'
    const id = await seedDevice(apiKey)

    const requested = await requestUpdate(app, id)
    assert.equal(requested.statusCode, 200)
    assert.deepEqual(requested.json(), { status: 'requested' })
    assert.equal((await updateRow(id)).update_state, 'requested')

    const first = await heartbeat(app, apiKey, { agentVersion: '1.0.0' })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().update, true)
    assert.equal((await updateRow(id)).update_state, 'delivered')

    const second = await heartbeat(app, apiKey, { agentVersion: '1.0.0' })
    assert.equal('update' in second.json(), false)
    assert.equal((await updateRow(id)).update_state, 'delivered')
  } finally {
    await app.close()
  }
})

test('an agent update report is stored with its message, and invalid reports are ignored', async () => {
  const app = buildApp()
  try {
    const apiKey = 'update-report-key-1234567890'
    const id = await seedDevice(apiKey)
    await requestUpdate(app, id)
    await heartbeat(app, apiKey, { agentVersion: '1.0.0' })

    for (const bad of [{ state: 'updated' }, { state: 'failed', message: 'x'.repeat(201) }, { state: 'failed', message: 5 }, 'failed']) {
      const response = await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: bad })
      assert.equal(response.statusCode, 200)
      assert.equal((await updateRow(id)).update_state, 'delivered')
    }

    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'installing' } })
    assert.equal((await updateRow(id)).update_state, 'installing')

    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'failed', message: '  GitHub HTTP 500  ' } })
    const row = await updateRow(id)
    assert.equal(row.update_state, 'failed')
    assert.equal(row.update_message, 'GitHub HTTP 500')

    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'up_to_date' } })
    assert.equal((await updateRow(id)).update_state, 'failed')
  } finally {
    await app.close()
  }
})

test('re-requesting while installing is not overwritten by the agent report and is delivered next', async () => {
  const app = buildApp()
  try {
    const apiKey = 'update-rerequest-key-1234567890'
    const id = await seedDevice(apiKey)
    await requestUpdate(app, id)
    await heartbeat(app, apiKey, { agentVersion: '1.0.0' })
    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'installing' } })

    await requestUpdate(app, id)
    assert.equal((await updateRow(id)).update_state, 'requested')

    const response = await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'failed', message: 'stale' } })
    assert.equal(response.json().update, true)
    const row = await updateRow(id)
    assert.equal(row.update_state, 'delivered')
    assert.equal(row.update_message, null)
  } finally {
    await app.close()
  }
})

test('a report without a delivered request does not change the update state', async () => {
  const app = buildApp()
  try {
    const apiKey = 'update-unsolicited-key-1234567890'
    const id = await seedDevice(apiKey)
    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'failed', message: 'nope' } })
    assert.equal((await updateRow(id)).update_state, null)
  } finally {
    await app.close()
  }
})

test('a version change after delivery marks the update as updated', async () => {
  const app = buildApp()
  try {
    const apiKey = 'update-version-key-1234567890'
    const id = await seedDevice(apiKey)
    await requestUpdate(app, id)
    await heartbeat(app, apiKey, { agentVersion: '1.0.0' })
    await heartbeat(app, apiKey, { agentVersion: '1.0.0', updateReport: { state: 'installing' } })

    const response = await heartbeat(app, apiKey, { agentVersion: '1.1.0' })
    assert.equal(response.statusCode, 200)
    assert.equal('update' in response.json(), false)
    const row = await updateRow(id)
    assert.equal(row.update_state, 'updated')
    assert.equal(row.agent_version, '1.1.0')
  } finally {
    await app.close()
  }
})

test('an update can only be requested for an existing paired device by an authenticated user', async () => {
  const app = buildApp()
  try {
    const unpairedId = await seedDevice('update-unpaired-key-1234567890', { paired: false })

    assert.equal((await requestUpdate(app, unpairedId)).statusCode, 409)
    assert.equal((await updateRow(unpairedId)).update_state, null)
    assert.equal((await requestUpdate(app, unpairedId + 1000)).statusCode, 404)

    const anonymous = await app.inject({ method: 'POST', url: `/devices/${unpairedId}/agent-update` })
    assert.equal(anonymous.statusCode, 401)

    const latest = await app.inject({ method: 'GET', url: '/agent-release/latest' })
    assert.equal(latest.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('the update state is exposed by GET /devices', async () => {
  const app = buildApp()
  try {
    const id = await seedDevice('update-list-key-1234567890')
    await requestUpdate(app, id)
    const response = await app.inject({ method: 'GET', url: '/devices', headers: await adminAuthHeader() })
    const device = response.json().devices.find((item: any) => item.id === id)
    assert.equal(device.update_state, 'requested')
    assert.ok(device.update_state_at)
  } finally {
    await app.close()
  }
})
