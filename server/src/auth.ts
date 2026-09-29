import jwt from 'jsonwebtoken'

import { JWT_SECRET } from './config.js'
import { getDb } from './database/index.js'

// ============================================================================
// Authentication module — JWT-based auth, refresh tokens, and request
// authentication middleware.
// ============================================================================

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
  '/agent/unpair',
])

/**
 * Normalize a request path by extracting the pathname only (no query string,
 * no fragment). This prevents authentication bypass via query parameters.
 * @param rawPath - Raw URL or path that may include query/fragment
 * @returns Normalized pathname starting with '/'
 */
const normalizeRequestPath = (rawPath = ''): string => {
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
const extractBearerToken = (headerValue = ''): string => {
  const candidate = (headerValue || '').trim()
  if (!candidate) return ''
  if (!candidate.startsWith('Bearer ')) return ''
  return candidate.slice('Bearer '.length).trim()
}

/**
 * Create a signed JWT token for an authenticated user.
 * Token payload carries the email claim plus the user's current token version,
 * which authMiddleware compares against the DB to allow instant revocation.
 * @param email - User email to embed in the token
 * @param tokenVersion - users.token_version at issue time
 * @returns Signed JWT string
 */
export const createToken = (email: string, tokenVersion: number): string =>
  jwt.sign({ email, tokenVersion }, JWT_SECRET, { expiresIn: '1d' })

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
 * Verify a JWT's signature/expiry, then confirm its tokenVersion claim matches
 * the current users.token_version in the DB. Shared by authMiddleware (HTTP)
 * and the WebSocket handshake so revocation logic lives in exactly one place.
 * 로그아웃·재사용 탐지가 users.token_version 을 올리므로, 그 이전에 발급된
 * access token 은 만료 전이라도 여기서 죽는다. tokenVersion 클레임이 없는
 * 구버전 토큰도 불일치로 처리해 거절한다 (재로그인 필요).
 * @param token - JWT to verify
 * @returns The matching user row, or null if invalid, expired, or revoked
 */
export const verifyTokenAndVersion = async (
  token: string,
): Promise<{ id: number; email: string; token_version: number } | null> => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; tokenVersion?: number }
    const db = await getDb()
    const user = await db.get(
      'SELECT id, email, token_version FROM users WHERE email = ?',
      [decoded.email],
    )
    if (!user) return null
    if (decoded.tokenVersion !== user.token_version) return null
    return user
  } catch {
    return null
  }
}

/**
 * Verifies the bearer token attached to an incoming request and attaches the user row to the request.
 * Extracts the token from the Authorization header, validates it using JWT verification,
 * and fetches the user record from the database if the token is valid.
 * @param request - Fastify request object containing headers
 * @param reply - Fastify reply object for sending error responses
 * Does not throw: replies 401 directly when the token is missing, invalid, expired, or the user is gone.
 */
export const authMiddleware = async (request: any, reply: any) => {
  const token = extractBearerToken(request.headers.authorization)

  if (!token) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }

  const user = await verifyTokenAndVersion(token)
  if (!user) {
    reply.code(401).send({ message: 'Invalid or expired token' })
    return
  }
  request.user = user
}
