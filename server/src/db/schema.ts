import type { Database } from 'sqlite'

/**
 * Create all tables, indexes and initial bootstrap data on a fresh database.
 * Idempotent — safe to run on every startup.
 */
export const createSchema = async (db: Database) => {
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
      lookup_id TEXT,
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_lookup_id ON refresh_tokens(lookup_id);
  `)
}
