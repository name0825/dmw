import bcrypt from 'bcryptjs'
import type { Database } from 'sqlite'

import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../config.js'

/**
 * Ensure an admin account exists for the configured administrator email.
 * This is a bootstrap guard that runs during startup and keeps the app usable in a fresh environment.
 */
export const ensureAdmin = async (db: Database) => {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])

  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)
    await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [ADMIN_EMAIL, passwordHash])
  }
}
