import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import bcrypt from 'bcryptjs'
import { ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH } from './config.js'

export const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
})

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
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS device_metrics_latest (
    device_id INTEGER PRIMARY KEY,
    cpu_usage REAL,
    memory_usage REAL,
    disk_usage REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS device_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    cpu_usage REAL,
    memory_usage REAL,
    disk_usage REAL,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );
`)

export const ensureAdmin = async () => {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])
  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)
    await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [ADMIN_EMAIL, passwordHash])
  }
}
