import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from './config.js'
import { db } from './db.js'

export const createToken = (email: string) => jwt.sign({ email }, JWT_SECRET, { expiresIn: '1d' })

export const isValidJwtToken = (token: string) => {
  if (!token) return false

  try {
    jwt.verify(token, JWT_SECRET)
    return true
  } catch {
    return false
  }
}

export const getUserFromRefreshToken = async (refreshToken: string) => {
  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) return null

  return db.get('SELECT id, email FROM users WHERE id = ?', [matched.user_id])
}

export const authMiddleware = async (request: any, reply: any) => {
  const header = request.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string }
    const user = await db.get('SELECT id, email FROM users WHERE email = ?', [decoded.email])
    if (!user) {
      reply.code(401).send({ message: 'Invalid token' })
      return
    }
    request.user = user
  } catch {
    reply.code(401).send({ message: 'Invalid or expired token' })
    return
  }
}

// Refresh tokens are 64-char hex strings (randomBytes(32)). The first 16 chars
// are stored as a unique lookup_id so we can do a single indexed lookup instead
// of bcrypt-comparing every active row (O(n) bcrypt = slow + DoS vector).
export const REFRESH_LOOKUP_LEN = 16

export const getRefreshLookupId = (refreshToken: string) => refreshToken.slice(0, REFRESH_LOOKUP_LEN)

export const findRefreshTokenMatch = async (refreshToken: string) => {
  // Fast path: single indexed lookup by lookup_id, then one bcrypt compare.
  const lookupId = getRefreshLookupId(refreshToken)
  const row = await db.get(
    'SELECT * FROM refresh_tokens WHERE lookup_id = ? AND revoked = 0',
    [lookupId],
  )
  if (row) {
    const ok = await bcrypt.compare(refreshToken, row.token_hash)
    if (ok) return row
    return null
  }

  // Fallback for legacy tokens issued before lookup_id existed (no lookup_id set).
  const legacyRows = await db.all('SELECT * FROM refresh_tokens WHERE lookup_id IS NULL AND revoked = 0')
  for (const legacy of legacyRows) {
    const ok = await bcrypt.compare(refreshToken, legacy.token_hash)
    if (ok) return legacy
  }
  return null
}

export const revokeRefreshToken = async (refreshToken: string) => {
  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) return
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
}
