import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { getDb } from './index.js'

/**
 * 리프레시 토큰 유효기간 (7 일). 쿠키 maxAge 와 DB expires_at 에 동일하게 사용됨.
 */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * API 속도 제한 설정 (인증 라우트용).
 */
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }

/**
 * API 속도 제한 설정 (리프레시 라우트용).
 */
export const REFRESH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' }

/**
 * Lookup ID 길이 (16 자) — refresh token 의 빠른 인덱스 조회를 위한 접두.
 */
export const REFRESH_LOOKUP_LEN = 16

/**
 * 리프레시 토큰을 생성하여 DB 에 저장하고 httpOnly 쿠키로 설정함.
 * 토큰 원문은 저장하지 않고 bcrypt 해시만 저장하며, 빠른 인덱스 조회를 위해
 * 16 자 접두 (lookup_id) 를 함께 저장함.
 * @param reply - Fastify reply 객체
 * @param userId - 토큰 소유자 user id
 */
export const issueRefreshToken = async (reply: any, userId: number) => {
  const refreshToken = crypto.randomBytes(32).toString('hex')
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
    secure: process.env.COOKIE_SECURE !== 'false',
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  })
}

/**
 * 쿠키 또는 바디에서 리프레시 토큰을 추출함.
 * 바디 우선순위는 기존 동작 (바디가 있으면 쿠키보다 우선) 을 보존함.
 * @param request - Fastify request 객체
 * @returns 리프레시 토큰 (없으면 빈 문자열)
 */
export const extractRefreshToken = (request: any): string => {
  const cookieToken = request.cookies?.refreshToken || ''
  const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken || ''
  return bodyToken || cookieToken
}

/**
 * 리프레시 토큰을 검증하고 일치하는 토큰 정보를 반환함.
 * 인덱스 (lookup_id) 를 사용하여 빠른 조회를 수행한 후 bcrypt 로 토큰을 검증함.
 * @param refreshToken - 검증할 리프레시 토큰
 * @returns 일치하는 토큰 정보 또는 null
 */
export const findRefreshTokenMatch = async (refreshToken: string) => {
  const lookupId = getRefreshLookupId(refreshToken)
  const row = await getDb().get(
    'SELECT * FROM refresh_tokens WHERE lookup_id = ? AND revoked = 0',
    [lookupId],
  )
  if (!row) return null

  const valid = await bcrypt.compare(refreshToken, row.token_hash)
  if (valid) return row

  // Legacy fallback for old databases missing lookup_id — use full table scan
  const legacyRows = await getDb().all('SELECT * FROM refresh_tokens WHERE lookup_id IS NULL AND revoked = 0')
  for (const legacy of legacyRows) {
    const valid = await bcrypt.compare(refreshToken, legacy.token_hash)
    if (valid) return legacy
  }
  return null
}

/**
 * 리프레시 토큰을 취소함.
 * @param tokenId - 취소할 리프레시 토큰의 주 키
 */
export const revokeRefreshToken = async (tokenId: number): Promise<void> => {
  await getDb().run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [tokenId])
}

/**
 * 리프레시 토큰의 lookup_id 접두를 추출함.
 * @param refreshToken - 64 자 리프레시 토큰
 * @returns 16 자 lookup_id 접두
 */
export const getRefreshLookupId = (refreshToken: string): string =>
  (refreshToken.slice(0, REFRESH_LOOKUP_LEN) || '').toLowerCase().trim()

/**
 * 관리자가 존재하는지 확인하고 없으면 생성함.
 * @param db - SQLite DB 연결
 */
export const ensureAdmin = async (db: any) => {
  const exists = await db.get('SELECT 1 FROM users WHERE role = ?', ['admin'])
  if (exists) return

  const passwordHash = await bcrypt.hash('admin123', 10)
  await db.run(
    'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [1, 'admin@dmw.local', passwordHash, 'admin', new Date().toISOString()],
  )
}