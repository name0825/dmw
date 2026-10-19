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
): Promise<{ id: number; email: string; token_version: number; role?: string } | null> => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; tokenVersion?: number }
    const db = await getDb()
    const user = await db.get(
      'SELECT id, email, token_version, role FROM users WHERE email = ?',
      [decoded.email],
    )
    if (!user) return null
    if (decoded.tokenVersion !== user.token_version) return null
    return user
  } catch {
    return null
  }
}

/** Consecutive failures allowed per throttle key before it is temporarily locked. */
export const ACCOUNT_LOCK_THRESHOLD = 5
/** First lock duration; doubles with every further failure up to the cap. */
const ACCOUNT_LOCK_BASE_MS = 30 * 1000
const ACCOUNT_LOCK_MAX_MS = 15 * 60 * 1000
/** A failure streak is forgotten after this long without a new failure. */
const ACCOUNT_FAILURE_TTL_MS = 15 * 60 * 1000
/** Failures per email (summed over all client IPs) allowed per window before the email is locked. */
export const EMAIL_FAILURE_CEILING = 100
const EMAIL_FAILURE_WINDOW_MS = 60 * 60 * 1000
export const ACCOUNT_THROTTLE_MAX_ENTRIES = 10_000
/** A (email, IP) pair that logged in successfully stays trusted this long. */
const TRUSTED_LOGIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

type ThrottleEntry = { count: number; startedAt: number; lockedUntil: number; expiresAt: number }

/** Streak counters keyed by `login|email|ip` and `ssh|userId`; kept apart so one flow cannot lock the other. */
const streakStates = new Map<string, ThrottleEntry>()
/** Hourly per-email failure totals across all IPs (distributed-guessing ceiling). */
const emailCeilingStates = new Map<string, ThrottleEntry>()
/** `login|email|ip` keys that recently logged in successfully, mapped to their trust expiry; insertion order = oldest first. */
const trustedLogins = new Map<string, number>()

const isTrusted = (key: string, now: number): boolean => {
  const expiresAt = trustedLogins.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt <= now) {
    trustedLogins.delete(key)
    return false
  }
  return true
}

const markTrusted = (key: string, now: number): void => {
  trustedLogins.delete(key)
  if (trustedLogins.size >= ACCOUNT_THROTTLE_MAX_ENTRIES) {
    const oldest = trustedLogins.keys().next().value
    if (oldest !== undefined) trustedLogins.delete(oldest)
  }
  trustedLogins.set(key, now + TRUSTED_LOGIN_TTL_MS)
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const lockRemaining = (states: Map<string, ThrottleEntry>, key: string, now: number): number => {
  const state = states.get(key)
  if (!state) return 0
  if (state.expiresAt <= now) {
    states.delete(key)
    return 0
  }
  return Math.max(0, state.lockedUntil - now)
}

/**
 * Frees one slot when the map is full. Expired entries go first, then the oldest unlocked
 * entry; an entry with lockedUntil > now is never evicted.
 * @returns false when every entry is currently locked and no slot could be freed
 */
const makeRoom = (states: Map<string, ThrottleEntry>, now: number): boolean => {
  if (states.size < ACCOUNT_THROTTLE_MAX_ENTRIES) return true
  let unlockedKey: string | undefined
  for (const [key, state] of states) {
    if (state.expiresAt <= now) {
      states.delete(key)
      return true
    }
    if (unlockedKey === undefined && state.lockedUntil <= now) unlockedKey = key
  }
  if (unlockedKey === undefined) return false
  states.delete(unlockedKey)
  return true
}

const streakLockMs = (count: number): number =>
  count >= ACCOUNT_LOCK_THRESHOLD
    ? Math.min(ACCOUNT_LOCK_BASE_MS * 2 ** (count - ACCOUNT_LOCK_THRESHOLD), ACCOUNT_LOCK_MAX_MS)
    : 0

/**
 * Reverts the streak failure an attempt recorded. If the entry is still the one the attempt wrote,
 * the pre-attempt snapshot is restored (nothing if there was none or it has lapsed), so a lock that
 * had lapsed is not revived. If another attempt has replaced it, only the count is decremented and
 * lockedUntil is never extended.
 */
const undoStreakFailure = (key: string, written: ThrottleEntry, previous: ThrottleEntry | undefined): void => {
  const now = Date.now()
  const state = streakStates.get(key)
  if (!state || state.expiresAt <= now) return
  if (state === written) {
    if (previous && previous.expiresAt > now) streakStates.set(key, previous)
    else streakStates.delete(key)
    return
  }
  const count = state.count - 1
  if (count <= 0) {
    streakStates.delete(key)
    return
  }
  state.count = count
  state.lockedUntil = Math.min(state.lockedUntil, count >= ACCOUNT_LOCK_THRESHOLD ? state.startedAt + streakLockMs(count) : 0)
}

const undoEmailFailure = (key: string, windowStartedAt: number): void => {
  const now = Date.now()
  const state = emailCeilingStates.get(key)
  if (!state || state.expiresAt <= now || state.startedAt !== windowStartedAt) return
  const count = state.count - 1
  if (count <= 0) {
    emailCeilingStates.delete(key)
    return
  }
  state.count = count
  state.lockedUntil = count >= EMAIL_FAILURE_CEILING ? state.expiresAt : 0
}

const recordStreakFailure = (key: string, now: number): boolean => {
  const previous = streakStates.get(key)
  const live = previous && previous.expiresAt > now ? previous : null
  const count = (live?.count ?? 0) + 1
  const lockMs = streakLockMs(count)
  if (!streakStates.delete(key) && !makeRoom(streakStates, now)) return false
  streakStates.set(key, { count, startedAt: now, lockedUntil: now + lockMs, expiresAt: now + ACCOUNT_FAILURE_TTL_MS })
  return true
}

const recordEmailFailure = (key: string, now: number): boolean => {
  const previous = emailCeilingStates.get(key)
  const live = previous && previous.expiresAt > now ? previous : null
  const count = (live?.count ?? 0) + 1
  const startedAt = live?.startedAt ?? now
  const expiresAt = startedAt + EMAIL_FAILURE_WINDOW_MS
  if (!emailCeilingStates.delete(key) && !makeRoom(emailCeilingStates, now)) return false
  emailCeilingStates.set(key, { count, startedAt, lockedUntil: count >= EMAIL_FAILURE_CEILING ? expiresAt : 0, expiresAt })
  return true
}

export type PasswordAttempt = {
  /** Milliseconds the caller must wait; when > 0 the attempt was refused and nothing was recorded. */
  lockedMs: number
  /** Call after the password verified: forgets the streak, undoes this attempt's email-ceiling count, and trusts the (email, IP) pair. */
  succeed: () => void
  /** Call when the check itself errored (not a wrong password): undoes only this attempt's up-front count and trusts nothing. */
  cancel: () => void
}

const refused = (lockedMs: number): PasswordAttempt => ({ lockedMs, succeed: () => {}, cancel: () => {} })

/**
 * Checks the lock and, if open, counts the attempt as a failure immediately — before the slow
 * password hash comparison — so concurrent requests cannot all slip past a lock that has just
 * lapsed. The caller invokes succeed() on a correct password, or cancel() if the check threw.
 * A trusted (email, IP) pair skips the per-email ceiling lock but is still subject to its own streak lock.
 * Refuses (fail closed) when the key cannot be tracked because the table holds only locked entries.
 */
const beginAttempt = (key: string, emailKey: string | null, now: number): PasswordAttempt => {
  const ceilingLocked = emailKey && !isTrusted(key, now) ? lockRemaining(emailCeilingStates, emailKey, now) : 0
  const lockedMs = Math.max(lockRemaining(streakStates, key, now), ceilingLocked)
  if (lockedMs > 0) return refused(lockedMs)
  const previousStreak = streakStates.get(key)
  if (!recordStreakFailure(key, now) || (emailKey && !recordEmailFailure(emailKey, now))) {
    return refused(ACCOUNT_LOCK_BASE_MS)
  }
  const writtenStreak = streakStates.get(key)!
  const windowStartedAt = emailKey ? emailCeilingStates.get(emailKey)!.startedAt : 0
  return {
    lockedMs: 0,
    succeed: () => {
      streakStates.delete(key)
      if (emailKey) {
        undoEmailFailure(emailKey, windowStartedAt)
        markTrusted(key, now)
      }
    },
    cancel: () => {
      undoStreakFailure(key, writtenStreak, previousStreak)
      if (emailKey) undoEmailFailure(emailKey, windowStartedAt)
    },
  }
}

/**
 * Login throttle, keyed on (lowercased email, client IP) so one LAN host cannot lock the
 * account for everyone, plus an hourly per-email ceiling to bound distributed guessing.
 * Unknown emails are tracked identically so lock state does not reveal whether an account exists.
 * State is in memory and resets on restart.
 */
export const beginLoginAttempt = (email: string, ip: string, now = Date.now()): PasswordAttempt => {
  const normalized = normalizeEmail(email)
  return beginAttempt(`login|${normalized}|${ip}`, normalized, now)
}

/** SSH password re-confirmation throttle, keyed on the authenticated user id and independent of login. */
export const beginSshConfirmAttempt = (userId: number, now = Date.now()): PasswordAttempt =>
  beginAttempt(`ssh|${userId}`, null, now)

/** Drops all throttle state (tests). */
export const resetPasswordThrottles = (): void => {
  streakStates.clear()
  emailCeilingStates.clear()
  trustedLogins.clear()
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
