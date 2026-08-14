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

export const findRefreshTokenMatch = async (refreshToken: string) => {
  const rows = await db.all('SELECT * FROM refresh_tokens WHERE revoked = 0')
  for (const row of rows) {
    const ok = await bcrypt.compare(refreshToken, row.token_hash)
    if (ok) return row
  }
  return null
}

export const revokeRefreshToken = async (refreshToken: string) => {
  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) return
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
}
