/**
 * Authentication helper functions
 * Provides reusable auth utilities that are used across routes
 */

import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

import { getDb } from '../database/index.js'
import { createToken } from '../middleware/auth.js'
import { AUTH_RATE_LIMIT, REFRESH_RATE_LIMIT, REFRESH_TOKEN_TTL_MS, COOKIE_SECURE } from '../config/constants.js'

/**
 * Issues a new refresh token, stores it in the database, and sets it as an httpOnly cookie.
 * Stores only the bcrypt hash (not the plain token) and saves the 16-character prefix
 * as lookup_id for fast indexing.
 * @param reply - Fastify reply object
 * @param userId - User ID who owns the token
 * @returns Promise that resolves when the token is issued
 */
export const issueRefreshToken = async (reply: any, userId: number) => {
  const refreshToken = randomBytes(32).toString('hex')
  const refreshHash = await bcrypt.hash(refreshToken, 10)
  const lookupId = getRefreshLookupId(refreshToken)
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()

  await getDb().run(
    'INSERT INTO refresh_tokens (user_id, token_hash, lookup_id, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)',
    [userId, refreshHash, lookupId, now, expiresAt],
  )

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: COOKIE_SECURE,
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  })
}

/**
 * Extracts a refresh token from cookie or body.
 * Body takes precedence over cookie (preserves existing behavior).
 * @param request - Fastify request object
 * @returns Refresh token string (empty string if not found)
 */
export const extractRefreshToken = (request: any): string => {
  const cookieToken = request.cookies?.refreshToken || ''
  const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken || ''
  return bodyToken || cookieToken
}

/**
 * Gets the 16-character lookup_id prefix from a refresh token
 * Used for fast index lookups in the database
 * @param refreshToken - The full refresh token
 * @returns The 16-character lookup_id prefix
 */
export const getRefreshLookupId = (refreshToken: string): string => {
  return refreshToken.slice(0, 16)
}

/**
 * Revoke a refresh token by marking it as revoked in the database
 * @param refreshToken - The refresh token to revoke
 */
export const revokeRefreshToken = async (refreshToken: string) => {
  const lookupId = getRefreshLookupId(refreshToken)
  await getDb().run(
    'UPDATE refresh_tokens SET revoked = 1 WHERE lookup_id = ? AND revoked = 0',
    [lookupId],
  )
}
