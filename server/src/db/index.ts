import fs from 'node:fs'
import path from 'node:path'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import bcrypt from 'bcryptjs'

import { ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH } from '../config.js'
import { createSchema } from './schema.js'
import { ensureAdmin as ensureAdminImpl } from './auth.js'

/**
 * The single SQLite connection shared across the whole application.
 * Users, refresh tokens, devices and telemetry all live in this one file so that
 * cross-table foreign keys and atomic transactions keep working.
 */
const databaseDirectory = path.dirname(DB_PATH)
fs.mkdirSync(databaseDirectory, { recursive: true })

export const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
})

await db.exec('PRAGMA foreign_keys = ON;')

// Initialize schema and bootstrap data on first run.
await createSchema(db)

// Clean up expired refresh tokens so the table does not grow unbounded.
await db.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [new Date().toISOString()])

// Backfill: older databases may be missing the refresh_tokens.user_id column.
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

// Exposed with the historical zero-arg signature: callers can just `await ensureAdmin()`.
export const ensureAdmin = () => ensureAdminImpl(db)
