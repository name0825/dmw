import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-devices-timestamp-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { handleUpdateDevice } = await import('./services/devices.js')
const { STATUS_WAKE_TIMEOUT, STATUS_ONLINE } = await import('./config/constants.js')

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

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('handleUpdateDevice leaves updated_at untouched while the device is WAKE_TIMEOUT', async () => {
  await initPool()
  const db = getDb()
  const wakeSentAt = new Date(Date.now() - 60_000).toISOString()

  const device = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device WT', 'AA:BB:CC:DD:EE:20', '192.168.1.50', STATUS_WAKE_TIMEOUT, wakeSentAt]
  )

  const res = reply()
  await handleUpdateDevice(
    {
      params: { id: device.lastID },
      body: { name: 'Device WT Renamed', mac_address: 'AA:BB:CC:DD:EE:20', ip_address: '192.168.1.50' },
    },
    res
  )
  assert.equal(res.status, 200)

  const row = await db.get('SELECT name, status, updated_at FROM devices WHERE id = ?', [device.lastID])
  assert.equal(row.name, 'Device WT Renamed')
  assert.equal(row.status, STATUS_WAKE_TIMEOUT)
  assert.equal(row.updated_at, wakeSentAt)

  await db.run('DELETE FROM devices WHERE id = ?', [device.lastID])
})

test('handleUpdateDevice returns 404 when the device is deleted between the existence check and the UPDATE', async () => {
  await initPool()
  const db = getDb()

  const device = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device Race', 'AA:BB:CC:DD:EE:22', '192.168.1.52', STATUS_ONLINE, new Date().toISOString()]
  )

  // 존재 확인 SELECT 직후, UPDATE 가 실행되기 전에 다른 요청이 이 디바이스를 삭제한 상황을 재현한다.
  const originalGet = db.get.bind(db)
  db.get = async (sql: string, params: unknown) => {
    const result = await originalGet(sql, params)
    if (sql === 'SELECT id FROM devices WHERE id = ?') {
      await db.run('DELETE FROM devices WHERE id = ?', [device.lastID])
    }
    return result
  }

  try {
    const res = reply()
    await handleUpdateDevice(
      {
        params: { id: device.lastID },
        body: { name: 'Device Race Renamed', mac_address: 'AA:BB:CC:DD:EE:22', ip_address: '192.168.1.52' },
      },
      res
    )
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, { message: 'Device not found' })
  } finally {
    db.get = originalGet
  }
})

test('handleUpdateDevice bumps updated_at when the device is not WAKE_TIMEOUT', async () => {
  await initPool()
  const db = getDb()
  const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString()

  const device = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device Online', 'AA:BB:CC:DD:EE:21', '192.168.1.51', STATUS_ONLINE, staleUpdatedAt]
  )

  const res = reply()
  await handleUpdateDevice(
    {
      params: { id: device.lastID },
      body: { name: 'Device Online Renamed', mac_address: 'AA:BB:CC:DD:EE:21', ip_address: '192.168.1.51' },
    },
    res
  )
  assert.equal(res.status, 200)

  const row = await db.get('SELECT name, status, updated_at FROM devices WHERE id = ?', [device.lastID])
  assert.equal(row.name, 'Device Online Renamed')
  assert.equal(row.status, STATUS_ONLINE)
  assert.notEqual(row.updated_at, staleUpdatedAt)

  await db.run('DELETE FROM devices WHERE id = ?', [device.lastID])
})
