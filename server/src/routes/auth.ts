import Fastify from 'fastify'

import { AUTH_RATE_LIMIT, REFRESH_RATE_LIMIT } from '../config/constants.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers authentication routes
 * @param app - Fastify app instance
 */
export const registerAuthRoutes = (app: any) => {
  app.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request: any, reply: any) => {
    return await handleLogin(request, reply)
  })

  app.post('/auth/refresh', { config: { rateLimit: REFRESH_RATE_LIMIT } }, async (request: any, reply: any) => {
    return await handleRefresh(request, reply)
  })

  app.post('/auth/logout', async (_request: any, reply: any) => {
    return await handleLogout(_request, reply)
  })
}

// ============================================================================
// Route handler functions (extracted for testability and reusability)
// ============================================================================

import bcrypt from 'bcryptjs'
import { ADMIN_EMAIL } from '../config.js'
import { getDb } from '../database/index.js'
import { createToken } from '../middleware/auth.js'
import {
  issueRefreshToken,
  extractRefreshToken,
  findRefreshTokenMatch,
  revokeRefreshToken,
} from '../services/auth.js'

/**
 * Login request handler
 * Validates credentials and issues access/refresh tokens
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Login response object
 */
export const handleLogin = async (request: any, reply: any) => {
  const { email, password } = (request.body || {}) as { email?: string; password?: string }
  if (!email || !password) {
    reply.code(400).send({ message: 'Email and password are required' })
    return
  }

  const user = await getDb().get('SELECT * FROM users WHERE email = ?', [email])
  if (!user) {
    reply.code(401).send({ message: 'Invalid credentials' })
    return
  }

  const isValidPassword = await bcrypt.compare(password, user.password_hash)
  if (!isValidPassword) {
    reply.code(401).send({ message: 'Invalid credentials' })
    return
  }

  const accessToken = createToken(user.email)
  await issueRefreshToken(reply, user.id)

  return { accessToken }
}

/**
 * Refresh token request handler
 * Validates refresh token and issues new access token
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Refresh response object
 */
export const handleRefresh = async (request: any, reply: any) => {
  const refreshToken = extractRefreshToken(request)

  if (!refreshToken) {
    reply.code(401).send({ message: 'Refresh token required' })
    return
  }

  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) {
    reply.code(401).send({ message: 'Invalid refresh token' })
    return
  }

  if (new Date(matched.expires_at).getTime() < Date.now()) {
    await getDb().run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
    reply.code(401).send({ message: 'Refresh token expired' })
    return
  }

  const user = await getDb().get('SELECT id, email FROM users WHERE id = ?', [matched.user_id])
  // NOTE: Falls back to ADMIN_EMAIL if user row no longer exists (preserves existing behavior)
  const email = user?.email || ADMIN_EMAIL
  const accessToken = createToken(email)

  // Revoke old token and issue new one (token rotation)
  await getDb().run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
  await issueRefreshToken(reply, matched.user_id)

  return { accessToken }
}

/**
 * Logout request handler
 * Revokes refresh token and clears cookie
 * @param _request - Fastify request (unused)
 * @param reply - Fastify reply
 * @returns Logout response object
 */
export const handleLogout = async (_request: any, reply: any) => {
  const refreshToken = extractRefreshToken(_request)

  if (refreshToken) {
    await revokeRefreshToken(refreshToken)
  }

  reply.clearCookie('refreshToken')
  return { message: 'Logged out' }
}
