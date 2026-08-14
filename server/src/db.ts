import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import bcrypt from 'bcryptjs'
import { ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH } from './config.js'

export const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
})

await db.exec('PRAGMA foreign_keys = ON;')

await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS devices (
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

  CREATE TABLE IF NOT EXISTS pairing_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS device_metrics_latest (
    device_id INTEGER PRIMARY KEY,
    cpu_usage REAL,
    memory_usage REAL,
    disk_usage REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS device_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    cpu_usage REAL,
    memory_usage REAL,
    disk_usage REAL,
    FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_agent_key_hint ON devices(agent_key_hint);
`)

const refreshColumns = await db.all('PRAGMA table_info(refresh_tokens)')
const hasUserId = refreshColumns.some((column: any) => column.name === 'user_id')
if (!hasUserId) {
  await db.exec('ALTER TABLE refresh_tokens ADD COLUMN user_id INTEGER')

  const adminUser = await db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])
  if (adminUser) {
    await db.run(
      `UPDATE refresh_tokens
       SET user_id = ?
       WHERE user_id IS NULL`,
      [adminUser.id],
    )
  } else {
    const inserted = await db.run(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 10)],
    )

    await db.run(
      `UPDATE refresh_tokens
       SET user_id = ?
       WHERE user_id IS NULL`,
      [(inserted as any).lastID],
    )
  }
}

export const ensureAdmin = async () => {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])

  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)
    await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [ADMIN_EMAIL, passwordHash])
    return
  }
}
