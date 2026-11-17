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
const { handleGetDevices } = await import('./services/devices.js')
const { updateOfflineStates } = await import('./services/monitoring.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute } = await import('./auth.js')
const { registerAgentRoutes } = await import('./routes/agent.js')

const { METRIC_KEYS: ALL_METRIC_KEYS } = await import('./metricSelection.js')

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
    assert.deepEqual(response.json(), { status: 'ok', collect: ALL_METRIC_KEYS })
  } finally {
    await app.close()
  }
})

test('a heartbeat stores new scalars and disks, aggregate disk_usage is the max, and /devices exposes them', async () => {
  const app = buildApp()
  try {
    const apiKey = 'extra-metrics-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        cpuUsage: 10,
        memoryUsage: 20,
        cpuTempC: 55,
        memoryTempC: 40,
        cpuClockMhz: 3200,
        memoryClockMhz: 4800,
        disks: [
          { name: 'C:', usage: 40.5, tempC: 35 },
          { name: 'D:', usage: 90 },
          { name: '', usage: 10 },
          { name: 'bad', usage: 500, tempC: 999 },
        ],
      },
    })
    assert.equal(response.statusCode, 200)

    const latest = await getDb().get('SELECT * FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.disk_usage, 90)
    assert.equal(latest.cpu_temp, 55)
    assert.equal(latest.memory_temp, 40)
    assert.equal(latest.cpu_clock, 3200)
    assert.equal(latest.memory_clock, 4800)
    assert.deepEqual(JSON.parse(latest.disks_json), [
      { name: 'C:', usage: 40.5, tempC: 35 },
      { name: 'D:', usage: 90 },
    ])
    const history = await getDb().get('SELECT * FROM device_metrics_history WHERE device_id = ?', [deviceId])
    assert.equal(history.cpu_temp, 55)
    assert.equal(history.disk_usage, 90)

    const reply: any = { code() { return this }, send(body: unknown) { this.body = body; return this } }
    await handleGetDevices({}, reply)
    const device = reply.body.devices[0]
    assert.equal(device.cpu_temp, 55)
    assert.equal(device.memory_clock, 4800)
    assert.equal(device.disks.length, 2)
    assert.deepEqual(device.metric_selection, ALL_METRIC_KEYS)
    assert.equal('disks_json' in device, false)
    assert.equal('agent_key_hash' in device, false)
  } finally {
    await app.close()
  }
})

test('Linux physical inventory and filesystem usage survive heartbeat storage and device serialization', async () => {
  const app = buildApp()
  try {
    const apiKey = 'linux-disks-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)
    const disks = [
      { name: 'nvme0n1', kind: 'physical', sizeBytes: 256060514304, tempC: 48 },
      { name: 'sda', kind: 'physical', sizeBytes: 2000398934016 },
      { name: 'sdb', kind: 'physical', sizeBytes: 8001563222016 },
      { name: '/', kind: 'filesystem', usage: 27.5 },
      { name: '/boot/efi', kind: 'filesystem', usage: 0.9 },
    ]
    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { disks },
    })
    assert.equal(response.statusCode, 200)
    const latest = await getDb().get('SELECT disk_usage, disks_json FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.disk_usage, 27.5)
    assert.deepEqual(JSON.parse(latest.disks_json), disks)
    const reply: any = { code() { return this }, send(body: unknown) { this.body = body; return this } }
    await handleGetDevices({}, reply)
    assert.deepEqual(reply.body.devices[0].disks, disks)
    const manyDisks = [
      ...Array.from({ length: 32 }, (_, i) => ({ name: `sd${i}`, kind: 'physical', sizeBytes: 1000000 })),
      ...Array.from({ length: 32 }, (_, i) => ({ name: `/mnt/sd${i}`, kind: 'filesystem', usage: i + 1 })),
    ]
    const manyResponse = await app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: `Bearer ${apiKey}` }, payload: { disks: manyDisks } })
    assert.equal(manyResponse.statusCode, 200)
    const manyLatest = await getDb().get('SELECT disk_usage, disks_json FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(manyLatest.disk_usage, 32)
    assert.deepEqual(JSON.parse(manyLatest.disks_json), manyDisks)
    await handleGetDevices({}, reply)
    assert.deepEqual(reply.body.devices[0].disks, manyDisks)
  } finally {
    await app.close()
  }
})

test('invalid extra metric values are dropped instead of rejected, and old-style bodies still work', async () => {
  const app = buildApp()
  try {
    const apiKey = 'old-agent-body-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)

    const dirty = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 5, cpuTempC: 'hot', memoryClockMhz: -1, disks: 'nope' },
    })
    assert.equal(dirty.statusCode, 200)

    const legacy = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 6, memoryUsage: 7, diskUsage: 8, agentVersion: '1.0.0' },
    })
    assert.equal(legacy.statusCode, 200)

    const latest = await getDb().get('SELECT * FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.cpu_usage, 6)
    assert.equal(latest.disk_usage, 8)
    assert.equal(latest.cpu_temp, null)
    assert.equal(latest.memory_clock, null)
    assert.equal(latest.disks_json, null)

    const invalidLegacy = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 101 },
    })
    assert.equal(invalidLegacy.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('deselected metrics are dropped from heartbeats, NULLed in latest, and reported in collect', async () => {
  const app = buildApp()
  try {
    const apiKey = 'selection-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)
    const headers = { authorization: `Bearer ${apiKey}` }

    await app.inject({ method: 'POST', url: '/agent/heartbeat', headers, payload: { cpuUsage: 10, diskUsage: 80, cpuTempC: 50 } })

    const { handleUpdateMetricSelection } = await import('./services/devices.js')
    const reply: any = { code(status: number) { this.status = status; return this }, send(body: unknown) { this.body = body; return this } }
    await handleUpdateMetricSelection({ params: { id: deviceId }, body: { metrics: ['cpu_usage', 'memory_usage'] } }, reply)
    assert.deepEqual(reply.body, { metrics: ['cpu_usage', 'memory_usage'] })

    let latest = await getDb().get('SELECT * FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.cpu_usage, 10)
    assert.equal(latest.disk_usage, null)
    assert.equal(latest.cpu_temp, null)

    const response = await app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers,
      payload: { cpuUsage: 11, diskUsage: 90, cpuTempC: 60, cpuClockMhz: 3000, disks: [{ name: 'C:', usage: 90, tempC: 30 }] },
    })
    assert.deepEqual(response.json(), { status: 'ok', collect: ['cpu_usage', 'memory_usage'] })

    latest = await getDb().get('SELECT * FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.cpu_usage, 11)
    assert.equal(latest.disk_usage, null)
    assert.equal(latest.cpu_temp, null)
    assert.equal(latest.cpu_clock, null)
    assert.equal(latest.disks_json, null)
  } finally {
    await app.close()
  }
})

test('a selection change committed while a heartbeat is authenticating still applies to that heartbeat', async () => {
  const app = buildApp()
  try {
    const apiKey = 'selection-race-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)

    const heartbeat = app.inject({
      method: 'POST',
      url: '/agent/heartbeat',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { cpuUsage: 10, diskUsage: 80 },
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    await getDb().run('UPDATE devices SET metric_selection = ? WHERE id = ?', [JSON.stringify(['cpu_usage']), deviceId])

    const response = await heartbeat
    assert.deepEqual(response.json(), { status: 'ok', collect: ['cpu_usage'] })
    const latest = await getDb().get('SELECT cpu_usage, disk_usage FROM device_metrics_latest WHERE device_id = ?', [deviceId])
    assert.equal(latest.cpu_usage, 10)
    assert.equal(latest.disk_usage, null)
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

test('a heartbeat stores agentVersion and a later heartbeat without a valid one keeps it', async () => {
  const app = buildApp()
  try {
    const apiKey = 'version-agent-key-1234567890'
    const deviceId = await seedPairedDevice(apiKey)
    const send = (payload?: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/agent/heartbeat', headers: { authorization: `Bearer ${apiKey}` }, payload })
    const stored = async () =>
      (await getDb().get('SELECT agent_version FROM devices WHERE id = ?', [deviceId])).agent_version

    assert.equal((await send({ cpuUsage: 1 })).statusCode, 200)
    assert.equal(await stored(), null)

    assert.equal((await send({ agentVersion: ' 1.2.3 ' })).statusCode, 200)
    assert.equal(await stored(), '1.2.3')

    let listed: any
    await handleGetDevices({}, { send: (body: unknown) => { listed = body } })
    assert.equal(listed.devices[0].agent_version, '1.2.3')

    for (const invalid of ['not a version', '1.2.3\n<script>', 'v'.repeat(40), 123, null, {}]) {
      assert.equal((await send({ agentVersion: invalid })).statusCode, 200)
      assert.equal(await stored(), '1.2.3')
    }

    assert.equal((await send({ agentVersion: '1.3.0-beta.1' })).statusCode, 200)
    assert.equal(await stored(), '1.3.0-beta.1')
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
