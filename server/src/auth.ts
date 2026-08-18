import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

import { JWT_SECRET } from './config.js'
import { getDb } from './database/index.js'

// ============================================================================
// Authentication module — JWT-based auth, refresh tokens, and request
// authentication middleware.
// ============================================================================

/**
 * Application errors — custom errors with structured metadata for
 * consistent error handling and logging.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 401,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Route metadata — classifies routes as public (no auth required) or private.
 * Public routes skip the authentication middleware and allow anonymous access.
 */
export const PUBLIC_ROUTE_PATHS = new Set([
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/health',
  '/agent/pair',
  '/agent/heartbeat',
])

/**
 * Normalize a request path by extracting the pathname only (no query string,
 * no fragment). This prevents authentication bypass via query parameters.
 * @param rawPath - Raw URL or path that may include query/fragment
 * @returns Normalized pathname starting with '/'
 */
export const normalizeRequestPath = (rawPath = ''): string => {
  const value = (rawPath || '').trim()
  if (!value) return '/'
  const pathname = value.split('?')[0].split('#')[0]
  return pathname.startsWith('/') ? pathname : `/${pathname}`
}

/**
 * Determine if a request path is public (skips auth middleware).
 * @param rawPath - URL or pathname to evaluate
 * @returns True if the path is public and requires no authentication
 */
export const isPublicRoute = (rawPath = '/'): boolean =>
  PUBLIC_ROUTE_PATHS.has(normalizeRequestPath(rawPath))

/**
 * Extract the JWT token from the Authorization header.
 * Expected format: "Bearer <token>" — returns the token without the prefix.
 * @param headerValue - Raw Authorization header value
 * @returns JWT token string, or empty string if not present
 */
export const extractBearerToken = (headerValue = ''): string => {
  const candidate = (headerValue || '').trim()
  if (!candidate) return ''
  if (!candidate.startsWith('Bearer ')) return ''
  return candidate.slice('Bearer '.length).trim()
}

/**
 * Create a signed JWT token for an authenticated user.
 * Token payload includes only the email claim for minimal data exposure.
 * @param email - User email to embed in the token
 * @returns Signed JWT string
 */
export const createToken = (email: string): string =>
  jwt.sign({ email }, JWT_SECRET, { expiresIn: '1d' })

/**
 * Validate whether a JWT is properly signed and not expired.
 * Does not decode or expose token contents — only validates signature.
 * @param token - JWT to verify
 * @returns True if the token is valid
 */
export const isValidJwtToken = (token: string): boolean => {
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
 * @param refreshToken - Refresh token string.
 * @returns Matching user row or null.
 */
export const getUserFromRefreshToken = async (refreshToken: string) => {
  const db = await getDb()
  const matched = await db.get('SELECT user_id FROM refresh_tokens WHERE token = ? AND revoked = 0', [refreshToken])
  if (!matched) return null

  return db.get('SELECT id, email FROM users WHERE id = ?', [matched.user_id])
}

/**
 * Verifies the bearer token attached to an incoming request and attaches the user row to the request.
 * Extracts the token from the Authorization header, validates it using JWT verification,
 * and fetches the user record from the database if the token is valid.
 * @param request - Fastify request object containing headers
 * @param reply - Fastify reply object for sending error responses
 * @throws AuthError when token is missing, invalid, expired, or user not found
 */
export const authMiddleware = async (request: any, reply: any) => {
  const token = extractBearerToken(request.headers.authorization)

  if (!token) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string }
    const db = await getDb()
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

/**
 * Refresh token format and security — tokens are 64-character hex strings
 * generated via randomBytes(32). The first 16 characters are stored as a unique
 * lookup_id to enable fast indexed lookups instead of O(n) bcrypt comparisons
 * across all active rows (which would be slow and a DoS vector).
 */

/**
 * Length of the lookup_id prefix used for fast refresh token lookups.
 */
export const REFRESH_LOOKUP_LEN = 16

/**
 * Extract the lookup_id prefix from a refresh token for indexed database queries.
 * @param refreshToken - Full 64-character refresh token
 * @returns 16-character lowercase lookup_id prefix
 */
export const getRefreshLookupId = (refreshToken: string): string =>
  (refreshToken.slice(0, REFRESH_LOOKUP_LEN) || '').toLowerCase().trim()

/**
 * Find a matching refresh token row using the indexed lookup_id and a single
 * bcrypt comparison. This optimization reduces database queries from scanning
 * hundreds of rows to a single indexed lookup.
 *
 * @param refreshToken - Candidate refresh token to verify
 * @returns Matching token row, or null if not found
 */
export const findRefreshTokenMatch = async (refreshToken: string): Promise<unknown | null> => {
  const db = await getDb()
  const lookupId = getRefreshLookupId(refreshToken)
  const row = await db.get('SELECT * FROM refresh_tokens WHERE lookup_id = ? AND revoked = 0', [
    lookupId,
  ])
  if (!row) return null

  const valid = await bcrypt.compare(refreshToken, row.token_hash)
  if (valid) return row

  // Legacy fallback for old databases missing lookup_id — use full table scan
  // (acceptable only during migration window)
  const legacyRows = await db.all('SELECT * FROM refresh_tokens WHERE lookup_id IS NULL AND revoked = 0')
  for (const legacy of legacyRows) {
    const valid = await bcrypt.compare(refreshToken, legacy.token_hash)
    if (valid) return legacy
  }
  return null
}

/**
 * Revoke a refresh token by marking it as used in the database.
 * @param tokenId - Primary key of the refresh token row to revoke
 */
export const revokeRefreshToken = async (tokenId: number): Promise<void> => {
  await getDb().run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [tokenId])
}
