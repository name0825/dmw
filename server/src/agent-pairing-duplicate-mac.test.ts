import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

// 이 파일은 devices(mac_address) 의 UNIQUE 인덱스가 없는(중복이 이미 남아있는)
// 구 DB 상황을 재현한다 — 초기화 순서가 중요하므로 initPool() 을 호출하기 전에
// devices 테이블을 직접 만들어 중복 MAC 행을 심어 둔다(devices-mac-unique.test.ts
// 의 "legacy" 시나리오와 동일한 방식).
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-pairing-dup-mac-test-'))
const dbFile = path.join(databaseDirectory, 'dmw.db')
process.env.DB_PATH = dbFile

const { initPool, closePool, getDb } = await import('./database/index.js')
const { handlePair } = await import('./services/agent.js')

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

test('an untargeted pairing code is rejected when any duplicate-MAC row is already paired', async () => {
  const duplicateMac = 'AA:BB:CC:DD:EE:88'
  const now = new Date().toISOString()
  const pairedHash = await bcrypt.hash('already-paired-key-abcdefgh', 10)

  // initPool() 을 호출하기 전에, 구 스키마(유니크 인덱스 없음)로 devices 테이블을
  // 만들고 같은 MAC 을 가진 두 행(id=1 미페어링, id=2 페어링)을 심는다.
  const seedDb = await sqlite.open({ filename: dbFile, driver: sqlite3.Database }) as any
  try {
    await seedDb.exec(`
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mac_address TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        agent_key_hash TEXT,
        agent_key_hint TEXT,
        agent_paired INTEGER NOT NULL DEFAULT 0,
        paired_at TEXT,
        last_seen TEXT,
        status TEXT NOT NULL DEFAULT 'NOT_PAIRED',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    await seedDb.run(
      'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['Unpaired Duplicate', duplicateMac, '192.168.1.50', 'NOT_PAIRED', now],
    )
    await seedDb.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, agent_paired, paired_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      ['Paired Duplicate', duplicateMac, '192.168.1.51', pairedHash, 'already-pai', now, 'ONLINE', now],
    )
  } finally {
    await seedDb.close()
  }

  // initDb 가 중복을 보고 유니크 인덱스 생성을 건너뛰는지 먼저 확인한다 — 이
  // 전제가 깨지면 아래 시나리오 자체가 성립하지 않는다.
  const db = await initPool()
  const indexes = await db.all('PRAGMA index_list(devices)')
  assert.ok(
    !indexes.some((index: any) => index.name === 'idx_devices_mac_address'),
    'unique index on devices(mac_address) should have been skipped given pre-existing duplicates',
  )

  await db.run(
    'INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)',
    ['DUPCODE1', new Date(Date.now() + 60_000).toISOString()],
  )

  const pairReply = reply()
  await handlePair(
    { body: { pairingCode: 'DUPCODE1', macAddress: duplicateMac, ipAddress: '192.168.1.52' } },
    pairReply,
  )
  assert.equal(pairReply.status, 409)

  const rows = await getDb().all(
    'SELECT agent_key_hash, agent_paired FROM devices WHERE mac_address = ? ORDER BY id ASC',
    [duplicateMac],
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].agent_key_hash, null)
  assert.equal(rows[0].agent_paired, 0)
  assert.equal(rows[1].agent_key_hash, pairedHash)
  assert.equal(rows[1].agent_paired, 1)

  const code = await getDb().get('SELECT used_at FROM pairing_codes WHERE code = ?', ['DUPCODE1'])
  assert.equal(code.used_at, null)
})
