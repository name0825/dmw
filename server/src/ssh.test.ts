import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-ssh-test-'))
process.env.DB_PATH = path.join(workDirectory, 'dmw.db')

const { ensureServerKey, getPublicKey } = await import('./services/sshKey.js')
const { acquireSlot, createOutputBuffer, toFingerprint, FINGERPRINT_PATTERN, SshError } = await import('./services/ssh.js')
const { initDb } = await import('./database/schema.js')

after(() => {
  fs.rmSync(workDirectory, { recursive: true, force: true })
})

test('ensureServerKey generates the key once, reuses it, and stores it owner-only', async () => {
  const keyPath = path.join(workDirectory, 'keys', 'dmw_ed25519')
  const first = await ensureServerKey(keyPath)
  const second = await ensureServerKey(keyPath)
  assert.equal(first, second)
  assert.match(first, /BEGIN OPENSSH PRIVATE KEY/)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(keyPath)).mode & 0o777, 0o700)
  }
  const publicKey = await getPublicKey(keyPath)
  assert.match(publicKey, /^ssh-ed25519 \S+ dmw-server$/)
  assert.ok(!publicKey.includes('PRIVATE'))
})

test('concurrent first calls to ensureServerKey converge on a single key', async () => {
  const keyPath = path.join(workDirectory, 'race', 'dmw_ed25519')
  const keys = await Promise.all([ensureServerKey(keyPath), ensureServerKey(keyPath), ensureServerKey(keyPath)])
  assert.equal(new Set(keys).size, 1)
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keys[0])
})

test('createOutputBuffer stops at the byte limit and reports truncation', () => {
  const buffer = createOutputBuffer(10)
  buffer.push(Buffer.from('12345'))
  assert.equal(buffer.isTruncated(), false)
  buffer.push(Buffer.from('6789012345'))
  buffer.push(Buffer.from('more'))
  assert.equal(buffer.text(), '1234567890')
  assert.equal(buffer.isTruncated(), true)

  const exact = createOutputBuffer(4)
  exact.push(Buffer.from('abcd'))
  assert.equal(exact.isTruncated(), false)
})

test('toFingerprint produces the OpenSSH SHA256 format', () => {
  const hex = crypto.createHash('sha256').update('host key').digest('hex')
  const fingerprint = toFingerprint(hex)
  assert.match(fingerprint, FINGERPRINT_PATTERN)
  assert.equal(fingerprint, `SHA256:${crypto.createHash('sha256').update('host key').digest('base64').replace(/=+$/, '')}`)
})

test('acquireSlot allows one run per device and frees the slot on release', () => {
  const release = acquireSlot(9001)
  assert.throws(() => acquireSlot(9001), (error: any) => error instanceof SshError && error.code === 'DEVICE_BUSY')
  release()
  release()
  const again = acquireSlot(9001)
  again()
})

test('acquireSlot enforces the global concurrency limit', () => {
  const releases = [9101, 9102, 9103, 9104].map((id) => acquireSlot(id))
  assert.throws(() => acquireSlot(9105), (error: any) => error instanceof SshError && error.code === 'GLOBAL_BUSY')
  releases.forEach((release) => release())
  acquireSlot(9105)()
})

test('initDb adds the SSH columns and command_runs table to a pre-existing database', async () => {
  const db = await sqlite.open({ filename: path.join(workDirectory, 'old.db'), driver: sqlite3.Database })
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
    await initDb(db)
    await initDb(db)
    const columns = (await db.all('PRAGMA table_info(devices)')).map((column: any) => column.name)
    for (const name of ['ssh_username', 'ssh_port', 'ssh_host_key', 'ssh_host_ip']) assert.ok(columns.includes(name), name)
    const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_runs'")
    assert.ok(table)
  } finally {
    await db.close()
  }
})
