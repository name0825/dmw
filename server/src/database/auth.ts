import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { ADMIN_EMAIL, ADMIN_PASSWORD, COOKIE_SECURE } from '../config.js'
import { getDb } from './index.js'

/**
 * 리프레시 토큰 유효기간 (7 일). 쿠키 maxAge 와 DB expires_at 에 동일하게 사용됨.
 */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Lookup ID 길이 (16 자) — refresh token 의 빠른 인덱스 조회를 위한 접두.
 */
export const REFRESH_LOOKUP_LEN = 16

/**
 * 회전 직후 유예 창 (30 초).
 * 이 안에 다시 제시된 폐기 토큰은 탈취가 아니라 정상 클라이언트의 중복/재시도 요청
 * (탭 2 개가 동시에 refresh, 네트워크 재시도) 으로 본다. 값을 줄이면 멀티탭 오탐이
 * 살아나고, 늘리면 탈취 토큰이 유효하게 통하는 창이 그만큼 길어진다.
 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000

/**
 * 리프레시 토큰 쿠키 옵션.
 * COOKIE_SECURE 는 config.ts 의 단일 정의를 따름 (프로덕션 기본 true, 그 외 기본 false).
 * 과거 인라인 `process.env.COOKIE_SECURE !== 'false'` 는 미설정 시 항상 true 였고,
 * 그로 인해 로컬 HTTP 개발에서 브라우저가 리프레시 쿠키를 버려 세션 복원이 조용히 깨졌음.
 */
export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: COOKIE_SECURE,
  maxAge: REFRESH_TOKEN_TTL_MS / 1000,
}

/**
 * 리프레시 토큰을 생성하여 DB 에 저장함.
 * 토큰 원문은 저장하지 않고 bcrypt 해시만 저장하며, 빠른 인덱스 조회를 위해
 * 16 자 접두 (lookup_id) 를 함께 저장함.
 * 쿠키 설정은 호출자 책임이다 (트랜잭션 롤백 시 쿠키가 새어나가지 않도록,
 * 트랜잭션이 커밋된 뒤에만 REFRESH_COOKIE_OPTIONS 로 설정해야 한다).
 * @param userId - 토큰 소유자 user id
 * @returns 새로 삽입된 refresh_tokens 행 id (회전 체인 연결용) 와 토큰 원문
 */
export const issueRefreshToken = async (
  userId: number,
  db: any = getDb(),
): Promise<{ id: number; token: string }> => {
  const refreshToken = crypto.randomBytes(32).toString('hex')
  const refreshHash = await bcrypt.hash(refreshToken, 10)
  const lookupId = getRefreshLookupId(refreshToken)
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()

  const inserted = await db.run(
    'INSERT INTO refresh_tokens (user_id, token_hash, lookup_id, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)',
    [userId, refreshHash, lookupId, now, expiresAt],
  )

  return { id: inserted?.lastID as number, token: refreshToken }
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
export const findRefreshTokenMatch = async (refreshToken: string, db: any = getDb()) =>
  matchRefreshToken(refreshToken, 0, db)

/**
 * 이미 취소된 (revoked = 1) 리프레시 토큰 중 일치하는 행을 반환함.
 * 회전 후 폐기된 토큰이 다시 제시되면 탈취 신호로 보기 위한 조회이며,
 * 조회 방식은 findRefreshTokenMatch 와 동일하게 유지해 타이밍 특성을 바꾸지 않음.
 * @param refreshToken - 검증할 리프레시 토큰
 * @param db - 트랜잭션 컨텍스트 (미지정 시 공유 커넥션)
 * @returns 일치하는 취소된 토큰 정보 또는 null
 */
export const findRevokedRefreshTokenMatch = async (refreshToken: string, db: any = getDb()) =>
  matchRefreshToken(refreshToken, 1, db)

const matchRefreshToken = async (refreshToken: string, revoked: 0 | 1, db: any) => {
  const lookupId = getRefreshLookupId(refreshToken)
  const row = await db.get(
    'SELECT * FROM refresh_tokens WHERE lookup_id = ? AND revoked = ?',
    [lookupId, revoked],
  )
  if (!row) return null

  const valid = await bcrypt.compare(refreshToken, row.token_hash)
  if (valid) return row

  // Legacy fallback for old databases missing lookup_id — use full table scan
  const legacyRows = await db.all(
    'SELECT * FROM refresh_tokens WHERE lookup_id IS NULL AND revoked = ?',
    [revoked],
  )
  for (const legacy of legacyRows) {
    const valid = await bcrypt.compare(refreshToken, legacy.token_hash)
    if (valid) return legacy
  }
  return null
}

/**
 * 리프레시 토큰을 취소함.
 * @param tokenId - 취소할 리프레시 토큰의 주 키
 * @param db - 트랜잭션 컨텍스트 (미지정 시 공유 커넥션)
 * @param replacedBy - 회전으로 대체한 후속 토큰 id (있으면 체인으로 기록)
 */
export const revokeRefreshToken = async (
  tokenId: number,
  db: any = getDb(),
  replacedBy: number | null = null,
): Promise<void> => {
  await db.run(
    'UPDATE refresh_tokens SET revoked = 1, revoked_at = ?, replaced_by = COALESCE(?, replaced_by) WHERE id = ?',
    [new Date().toISOString(), replacedBy, tokenId],
  )
}

/**
 * 폐기된 토큰에서 replaced_by 체인을 따라가 아직 살아 있는 회전 체인의 끝을 찾음.
 * 유예 창 안의 중복 refresh 요청을 처리할 때, 이미 발급된 후속 토큰을 다시 회전시켜
 * "체인당 살아 있는 토큰은 하나" 라는 불변식을 유지하기 위해 사용함.
 * @param row - 시작점이 되는 refresh_tokens 행
 * @param db - 트랜잭션 컨텍스트 (미지정 시 공유 커넥션)
 * @returns 살아 있는 체인 끝 행, 체인이 모두 폐기됐으면 null
 */
export const findLiveRotationTip = async (row: any, db: any = getDb()) => {
  let current = row
  // 체인 손상 시 무한 루프를 막기 위한 상한. 정상 흐름에서는 1~2 홉이면 끝난다.
  for (let hop = 0; hop < 10; hop += 1) {
    if (!current.revoked) return current
    if (!current.replaced_by) return null
    const next = await db.get('SELECT * FROM refresh_tokens WHERE id = ?', [current.replaced_by])
    if (!next) return null
    current = next
  }
  return null
}

/**
 * 한 사용자의 모든 리프레시 토큰을 취소함 (토큰 재사용 탐지 시 사용).
 * @param userId - 대상 user id
 * @param db - 트랜잭션 컨텍스트 (미지정 시 공유 커넥션)
 * @returns 취소된 행 수
 */
export const revokeAllRefreshTokensForUser = async (userId: number, db: any = getDb()): Promise<number> => {
  const result = await db.run(
    'UPDATE refresh_tokens SET revoked = 1, revoked_at = ? WHERE user_id = ? AND revoked = 0',
    [new Date().toISOString(), userId],
  )
  return result?.changes ?? 0
}

/**
 * 사용자의 token_version 을 1 올려 이미 발급된 access token 을 즉시 무효화함.
 * 로그아웃과 재사용 탐지에서 호출되며, authMiddleware 가 JWT 의 tokenVersion 과
 * 대조해 버전이 다른 토큰을 거절한다.
 * @param userId - 대상 user id
 * @param db - 트랜잭션 컨텍스트 (미지정 시 공유 커넥션)
 */
export const bumpTokenVersion = async (userId: number, db: any = getDb()): Promise<void> => {
  await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId])
}

/**
 * 리프레시 토큰의 lookup_id 접두를 추출함.
 * @param refreshToken - 64 자 리프레시 토큰
 * @returns 16 자 lookup_id 접두
 */
export const getRefreshLookupId = (refreshToken: string): string =>
  (refreshToken.slice(0, REFRESH_LOOKUP_LEN) || '').toLowerCase().trim()

/**
 * 만료된 리프레시 토큰 행을 삭제함.
 * revoked 여부와 무관하게 expires_at 이 지난 행만 지운다 — 재사용 탐지
 * (findRevokedRefreshTokenMatch, findLiveRotationTip) 는 폐기됐지만 아직
 * 만료되지 않은 행에 의존하므로 그런 행은 건드리지 않는다.
 * @param db - SQLite DB 연결
 * @returns 삭제된 행 수
 */
export const pruneExpiredRefreshTokens = async (db: any = getDb()): Promise<number> => {
  const result = await db.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [new Date().toISOString()])
  return result?.changes ?? 0
}

/**
 * 관리자가 존재하는지 확인하고 없으면 생성함.
 * @param db - SQLite DB 연결
 */
export const ensureAdmin = async (db: any) => {
  const exists = await db.get('SELECT 1 FROM users WHERE role = ?', ['admin'])
  if (exists) return

  // 자격 증명은 환경 변수에서 읽는다. 하드코딩하면 운영에서 ADMIN_PASSWORD 를
  // 바꿔도 계정이 그대로 남아 사실상 공개 계정이 된다.
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)
  await db.run(
    'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
    [ADMIN_EMAIL, passwordHash, 'admin', new Date().toISOString()],
  )
}