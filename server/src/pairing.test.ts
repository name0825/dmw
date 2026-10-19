import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-pairing-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { handleCreatePairingCode } = await import('./services/pairing.js')

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

beforeEach(async () => {
  const db = await initPool()
  await db.exec('DELETE FROM pairing_codes; DELETE FROM devices;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('rejects non-integer deviceId', async () => {
  const createReply = reply()
  await handleCreatePairingCode({ body: { deviceId: 1.5 } }, createReply)
  assert.equal(createReply.status, 400)
})

test('rejects zero/negative deviceId', async () => {
  const zeroReply = reply()
  await handleCreatePairingCode({ body: { deviceId: 0 } }, zeroReply)
  assert.equal(zeroReply.status, 400)

  const negativeReply = reply()
  await handleCreatePairingCode({ body: { deviceId: -1 } }, negativeReply)
  assert.equal(negativeReply.status, 400)
})

test('404s when the target device does not exist', async () => {
  const createReply = reply()
  await handleCreatePairingCode({ body: { deviceId: 999 } }, createReply)
  assert.equal(createReply.status, 404)
})

test('binds the issued code to an existing device', async () => {
  const db = getDb()
  const now = new Date().toISOString()
  const insertResult = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device A', 'AA:BB:CC:DD:EE:99', '192.168.1.60', 'NOT_PAIRED', now],
  )
  const deviceId = insertResult.lastID as number

  const createReply = reply()
  await handleCreatePairingCode({ body: { deviceId } }, createReply)
  assert.equal(createReply.status, 201)

  const { code } = createReply.body as { code: string }
  const row = await db.get('SELECT target_device_id FROM pairing_codes WHERE code = ?', [code])
  assert.equal(row.target_device_id, deviceId)
})

test('issues an untargeted code when deviceId is omitted', async () => {
  const createReply = reply()
  await handleCreatePairingCode({ body: {} }, createReply)
  assert.equal(createReply.status, 201)

  const { code } = createReply.body as { code: string }
  const row = await getDb().get('SELECT target_device_id FROM pairing_codes WHERE code = ?', [code])
  assert.equal(row.target_device_id, null)
})

test('pruneExpiredPairingCodes deletes expired and used codes but keeps active ones', async () => {
  const { pruneExpiredPairingCodes } = await import('./services/pairing.js')
  const db = getDb()
  const past = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 60_000).toISOString()
  await db.run('INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)', ['EXPIRED1', past])
  await db.run('INSERT INTO pairing_codes (code, expires_at, used_at) VALUES (?, ?, ?)', ['USED0001', future, past])
  await db.run('INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)', ['ACTIVE01', future])

  assert.equal(await pruneExpiredPairingCodes(), 2)
  assert.deepEqual(await db.all('SELECT code FROM pairing_codes'), [{ code: 'ACTIVE01' }])
})
