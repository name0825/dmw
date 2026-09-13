import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-devices-mac-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initDb } = await import('./database/schema.js')
const { initPool, closePool, getDb } = await import('./database/index.js')
const { handleUpdateDevice } = await import('./services/devices.js')

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

const openRawDb = async (filename: string) =>
  sqlite.open({ filename, driver: sqlite3.Database }) as any

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('initDb creates a unique index on devices(mac_address) that rejects duplicate MACs', async () => {
  const dbFile = path.join(databaseDirectory, 'fresh.db')
  const db = await openRawDb(dbFile)
  try {
    await initDb(db)

    const indexes = await db.all('PRAGMA index_list(devices)')
    const macIndex = indexes.find((index: any) => index.name === 'idx_devices_mac_address')
    assert.ok(macIndex, 'idx_devices_mac_address should exist')
    assert.equal(macIndex.unique, 1)

    await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
      ['Device A', 'AA:BB:CC:DD:EE:01', '192.168.1.20', 'NOT_PAIRED']
    )

    await assert.rejects(
      db.run(
        'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
        ['Device B', 'AA:BB:CC:DD:EE:01', '192.168.1.21', 'NOT_PAIRED']
      ),
      (error: any) => String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
    )
  } finally {
    await db.close()
  }
})

test('initDb is idempotent when run twice against the same database', async () => {
  const dbFile = path.join(databaseDirectory, 'idempotent.db')
  const db = await openRawDb(dbFile)
  try {
    await initDb(db)
    await assert.doesNotReject(initDb(db))
  } finally {
    await db.close()
  }
})

test('initDb does not throw and preserves rows when a legacy database already has duplicate MACs', async () => {
  const dbFile = path.join(databaseDirectory, 'legacy.db')
  const db = await openRawDb(dbFile)
  try {
    await db.exec(`
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
    await db.run(
      'INSERT INTO devices (name, mac_address, ip_address) VALUES (?, ?, ?)',
      ['Legacy A', 'AA:BB:CC:DD:EE:02', '192.168.1.30']
    )
    await db.run(
      'INSERT INTO devices (name, mac_address, ip_address) VALUES (?, ?, ?)',
      ['Legacy B', 'AA:BB:CC:DD:EE:02', '192.168.1.31']
    )

    await assert.doesNotReject(initDb(db))

    const rows = await db.all(
      'SELECT name FROM devices WHERE mac_address = ? ORDER BY name',
      ['AA:BB:CC:DD:EE:02']
    )
    assert.deepEqual(rows.map((row: any) => row.name), ['Legacy A', 'Legacy B'])

    const indexes = await db.all('PRAGMA index_list(devices)')
    assert.ok(!indexes.some((index: any) => index.name === 'idx_devices_mac_address'))
  } finally {
    await db.close()
  }
})

test('initDb adds pairing_codes.target_device_id to a legacy database without it', async () => {
  const dbFile = path.join(databaseDirectory, 'legacy-pairing-codes.db')
  const db = await openRawDb(dbFile)
  try {
    await db.exec(`
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
      CREATE TABLE pairing_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER,
        code TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
      );
    `)
    await db.run(
      'INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)',
      ['LEGACY01', new Date(Date.now() + 60_000).toISOString()]
    )

    await assert.doesNotReject(initDb(db))

    const columns = await db.all('PRAGMA table_info(pairing_codes)')
    assert.ok(columns.some((column: any) => column.name === 'target_device_id'))

    const row = await db.get('SELECT target_device_id FROM pairing_codes WHERE code = ?', ['LEGACY01'])
    assert.equal(row.target_device_id, null)

    await assert.doesNotReject(initDb(db))
  } finally {
    await db.close()
  }
})

test('handleUpdateDevice rejects renaming to another device\'s MAC but allows keeping its own MAC', async () => {
  await initPool()
  const db = getDb()
  const now = new Date().toISOString()

  const deviceA = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device A', 'AA:BB:CC:DD:EE:10', '192.168.1.40', 'NOT_PAIRED', now]
  )
  const deviceB = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Device B', 'AA:BB:CC:DD:EE:11', '192.168.1.41', 'NOT_PAIRED', now]
  )

  const conflictReply = reply()
  await handleUpdateDevice(
    {
      params: { id: deviceA.lastID },
      body: { name: 'Device A', mac_address: 'AA:BB:CC:DD:EE:11', ip_address: '192.168.1.40' },
    },
    conflictReply
  )
  assert.equal(conflictReply.status, 409)
  assert.deepEqual(conflictReply.body, { message: 'A device with this MAC address already exists' })

  const unchanged = await db.get('SELECT mac_address FROM devices WHERE id = ?', [deviceA.lastID])
  assert.equal(unchanged.mac_address, 'AA:BB:CC:DD:EE:10')

  const renameReply = reply()
  await handleUpdateDevice(
    {
      params: { id: deviceA.lastID },
      body: { name: 'Device A Renamed', mac_address: 'AA:BB:CC:DD:EE:10', ip_address: '192.168.1.40' },
    },
    renameReply
  )
  assert.equal(renameReply.status, 200)
  assert.deepEqual(renameReply.body, { message: 'Device updated successfully' })

  const renamed = await db.get('SELECT name, mac_address FROM devices WHERE id = ?', [deviceA.lastID])
  assert.equal(renamed.name, 'Device A Renamed')
  assert.equal(renamed.mac_address, 'AA:BB:CC:DD:EE:10')

  await db.run('DELETE FROM devices WHERE id IN (?, ?)', [deviceA.lastID, deviceB.lastID])
})
