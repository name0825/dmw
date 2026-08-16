import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

import { JWT_SECRET } from './config.js'
import { db } from './db.js'

const PUBLIC_ROUTE_PATHS = new Set([
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/health',
  '/agent/pair',
  '/agent/heartbeat',
])

/**
 * Normalize a request path so auth checks are based on pathname instead of raw URL strings.
 * This prevents query strings such as `/auth/login?next=/` from bypassing auth gating.
 * @param {string} rawPath - Raw URL or path that may contain query strings.
 * @returns {string} Pathname only.
 */
export const normalizeRequestPath = (rawPath = ''): string => {
  try {
    const value = rawPath.trim() || '/'
    const normalized = value.split('?')[0].split('#')[0]
    return normalized.startsWith('/') ? normalized : `/${normalized}`
  } catch {
    return '/'
  }
}

/**
 * Determine whether a route is intentionally public and should skip Access Token validation.
 * @param {string} rawPath - URL or pathname to evaluate.
 * @returns {boolean} True for routes that are safe to access anonymously.
 */
export const isPublicRoute = (rawPath = '/'): boolean => PUBLIC_ROUTE_PATHS.has(normalizeRequestPath(rawPath))

/**
 * Extract a bearer token from the Authorization header.
 * @param {string | undefined} headerValue - Raw Authorization header.
 * @returns {string} The JWT token without the Bearer prefix.
 */
export const extractBearerToken = (headerValue = ''): string => {
  const candidate = headerValue.trim()
  if (!candidate.startsWith('Bearer ')) return ''
  return candidate.slice('Bearer '.length).trim()
}

/**
 * Create a signed JWT for an authenticated user.
 * @param {string} email - User email to embed in the token claim.
 * @returns {string} Signed JWT.
 */
export const createToken = (email: string) => jwt.sign({ email }, JWT_SECRET, { expiresIn: '1d' })

/**
 * Validate whether a JWT is signed with the configured secret.
 * @param {string} token - JWT to verify.
 * @returns {boolean} True when the token is valid.
 */
export const isValidJwtToken = (token: string) => {
  if (!token) return false

  try {
    jwt.verify(token, JWT_SECRET)
    return true
  } catch {
    return false
  }
}

/**
 * Fetch a user record from a refresh token.
 * @param {string} refreshToken - Refresh token string.
 * @returns {Promise<object | null>} Matching user row or null.
 */
export const getUserFromRefreshToken = async (refreshToken: string) => {
  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) return null

  return db.get('SELECT id, email FROM users WHERE id = ?', [matched.user_id])
}

/**
 * Verify the bearer token attached to an incoming request and attach the user row to the request.
 * @param {any} request - Fastify request object.
 * @param {any} reply - Fastify reply object.
 */
export const authMiddleware = async (request: any, reply: any) => {
  const token = extractBearerToken(request.headers.authorization)

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

/**
 * Return the unique lookup hash prefix used to find the matching refresh token.
 * @param {string} refreshToken - Refresh token value.
 * @returns {string} The lookup ID prefix.
 */
export const getRefreshLookupId = (refreshToken: string) => refreshToken.slice(0, REFRESH_LOOKUP_LEN)

/**
 * Find a matching refresh token row using the indexed lookup ID and one bcrypt comparison.
 * @param {string} refreshToken - Candidate refresh token.
 * @returns {Promise<object | null>} Matching token row or null.
 */
export const findRefreshTokenMatch = async (refreshToken: string) => {
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

  const legacyRows = await db.all('SELECT * FROM refresh_tokens WHERE lookup_id IS NULL AND revoked = 0')
  for (const legacy of legacyRows) {
    const ok = await bcrypt.compare(refreshToken, legacy.token_hash)
    if (ok) return legacy
  }
  return null
}

/**
 * Revoke a refresh token so it cannot be used again.
 * @param {string} refreshToken - Refresh token to invalidate.
 */
export const revokeRefreshToken = async (refreshToken: string) => {
  const matched = await findRefreshTokenMatch(refreshToken)
  if (!matched) return
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
}
