import { AUTH_RATE_LIMIT_MAX, REFRESH_RATE_LIMIT_MAX } from '../config/constants.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers authentication routes
 * @param app - Fastify app instance
 */
export const registerAuthRoutes = (app: any) => {
  app.post('/auth/login', { config: { rateLimit: { max: AUTH_RATE_LIMIT_MAX } } }, async (request: any, reply: any) => {
    return await handleLogin(request, reply)
  })

  app.post('/auth/refresh', { config: { rateLimit: { max: REFRESH_RATE_LIMIT_MAX } } }, async (request: any, reply: any) => {
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
import { getDb, withTransaction } from '../database/index.js'
import { beginLoginAttempt, createToken } from '../auth.js'
import {
  issueRefreshToken,
  extractRefreshToken,
  findRefreshTokenMatch,
  findRevokedRefreshTokenMatch,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  findLiveRotationTip,
  bumpTokenVersion,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_COOKIE_OPTIONS,
} from '../database/auth.js'

/**
 * 리프레시 토큰을 httpOnly 쿠키로 설정한다.
 * 트랜잭션 안에서 발급된 토큰이라면 트랜잭션이 커밋된 뒤에만 호출해야,
 * 롤백 시 존재하지 않는 토큰의 쿠키가 응답에 실리는 것을 막을 수 있다.
 * @param reply - Fastify reply 객체
 * @param token - 쿠키에 설정할 리프레시 토큰 원문
 */
const setRefreshCookie = (reply: any, token: string) => {
  reply.setCookie('refreshToken', token, REFRESH_COOKIE_OPTIONS)
}

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dmw-dummy-password', 10)

/**
 * Login request handler
 * Validates credentials and issues access/refresh tokens
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Login response object
 */
export const handleLogin = async (request: any, reply: any) => {
  const { email, password } = (request.body || {}) as { email?: unknown; password?: unknown }
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    reply.code(400).send({ message: 'Email and password are required' })
    return
  }

  const attempt = beginLoginAttempt(email, String(request.ip ?? 'unknown'))
  if (attempt.lockedMs > 0) {
    reply.header?.('Retry-After', String(Math.ceil(attempt.lockedMs / 1000)))
    reply.code(429).send({ message: 'Too many failed attempts. Try again later.' })
    return
  }

  let user: any
  let isValidPassword = false
  try {
    user = await getDb().get('SELECT * FROM users WHERE email = ?', [email])
    isValidPassword = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH)
  } catch (error) {
    attempt.cancel()
    throw error
  }
  if (!user || !isValidPassword) {
    reply.code(401).send({ message: 'Invalid credentials' })
    return
  }
  attempt.succeed()

  const accessToken = createToken(user.email, user.token_version ?? 0)
  const { token } = await issueRefreshToken(user.id)
  setRefreshCookie(reply, token)

  return { accessToken }
}

/**
 * 살아 있는 리프레시 토큰 행을 회전시킨다 (후속 토큰 발급 → 기존 토큰 폐기).
 * 폐기 시 후속 토큰 id 를 replaced_by 로 기록해, 유예 창 안의 중복 요청이 체인을
 * 따라 현재 살아 있는 토큰을 찾을 수 있게 한다.
 * 쿠키는 여기서 설정하지 않는다 — 트랜잭션이 롤백되면 방금 발급한 토큰도 함께
 * 사라지므로, 호출자가 트랜잭션 커밋 후에 반환된 refreshToken 으로 쿠키를 설정해야 한다.
 * @param row - 회전 대상 refresh_tokens 행 (revoked = 0)
 * @param tx - 트랜잭션 컨텍스트
 * @returns 회전 결과 (만료 시 expired)
 */
const rotateRefreshToken = async (row: any, tx: any) => {
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await revokeRefreshToken(row.id, tx)
    return { status: 'expired' as const }
  }

  const user = await tx.get('SELECT id, email, token_version FROM users WHERE id = ?', [row.user_id])
  if (!user) {
    await revokeRefreshToken(row.id, tx)
    return { status: 'invalid' as const }
  }

  const successor = await issueRefreshToken(row.user_id, tx)
  await revokeRefreshToken(row.id, tx, successor.id)

  return {
    status: 'ok' as const,
    accessToken: createToken(user.email, user.token_version ?? 0),
    refreshToken: successor.token,
  }
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

  // 조회 → 폐기 → 재발급을 한 트랜잭션에 묶는다. 트랜잭션 밖에서 하면 같은 토큰으로
  // 들어온 동시 요청 2건이 모두 revoked = 0 검사를 통과해, 유효한 후속 토큰이 둘 발급된다
  // (withTransaction 은 트랜잭션끼리만 직렬화하므로 트랜잭션 밖 조회는 보호되지 않는다).
  const outcome = await withTransaction(async (tx) => {
    const matched = await findRefreshTokenMatch(refreshToken, tx)
    if (matched) return await rotateRefreshToken(matched, tx)

    const revokedMatch = await findRevokedRefreshTokenMatch(refreshToken, tx)
    if (!revokedMatch) return { status: 'invalid' as const }
    if (new Date(revokedMatch.expires_at).getTime() < Date.now()) return { status: 'expired' as const }

    // 폐기된 토큰의 재제시라고 곧바로 탈취로 보면, 같은 쿠키를 든 정상 요청 2 건
    // (탭 2 개의 동시 refresh, 클라이언트 재시도) 이 전체 세션 무효화를 유발한다.
    // 그래서 회전 직후 REFRESH_REUSE_GRACE_MS 안의 재제시는 정당한 중복 요청으로 보고,
    // 이미 발급된 후속 토큰 (회전 체인의 끝) 을 다시 회전시켜 응답한다.
    // revoked_at 이 없는 구 스키마 행은 유예 대상이 아니므로 재사용으로 처리된다.
    const revokedAt = revokedMatch.revoked_at ? new Date(revokedMatch.revoked_at).getTime() : 0
    if (Date.now() - revokedAt <= REFRESH_REUSE_GRACE_MS) {
      const tip = await findLiveRotationTip(revokedMatch, tx)
      // 체인이 이미 모두 폐기됐으면 (로그아웃 직후, 앞선 탐지 이후) 재발급 없이 거절만 한다.
      if (!tip) return { status: 'invalid' as const }
      return await rotateRefreshToken(tip, tx)
    }

    // 유예 창 밖의 재제시는 탈취 신호로 본다. 어느 사본이 공격자 것인지 알 수 없으므로
    // 해당 사용자의 refresh 토큰을 전부 무효화하고, token_version 을 올려 이미 발급된
    // access token 까지 함께 죽인다 — user_id 가 무효화 단위다.
    const revokedCount = await revokeAllRefreshTokensForUser(revokedMatch.user_id, tx)
    await bumpTokenVersion(revokedMatch.user_id, tx)
    return { status: 'reused' as const, userId: revokedMatch.user_id, revokedCount }
  })

  if (outcome.status === 'reused') {
    console.warn(
      `Refresh token reuse detected for user ${outcome.userId}; revoked ${outcome.revokedCount} active refresh token(s)`,
    )
    reply.clearCookie('refreshToken')
    reply.code(401).send({ message: 'Invalid refresh token' })
    return
  }

  if (outcome.status === 'invalid') {
    reply.code(401).send({ message: 'Invalid refresh token' })
    return
  }

  if (outcome.status === 'expired') {
    reply.clearCookie('refreshToken')
    reply.code(401).send({ message: 'Refresh token expired' })
    return
  }

  // 트랜잭션이 성공적으로 커밋된 뒤에만 쿠키를 설정한다. 트랜잭션 안에서 설정하면
  // 이후 같은 트랜잭션에서 발생한 롤백에도 reply 가 이미 변경돼 있어, DB 에 존재하지
  // 않는 토큰의 쿠키가 응답에 실려 나간다.
  setRefreshCookie(reply, outcome.refreshToken)

  return { accessToken: outcome.accessToken }
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
    const outcome = await withTransaction(async (tx) => {
      const matched = await findRefreshTokenMatch(refreshToken, tx)
      const revokedCandidate = matched ? null : await findRevokedRefreshTokenMatch(refreshToken, tx)
      const revokedMatch =
        revokedCandidate && new Date(revokedCandidate.expires_at).getTime() >= Date.now() ? revokedCandidate : null

      if (revokedMatch) {
        const revokedAt = revokedMatch.revoked_at ? new Date(revokedMatch.revoked_at).getTime() : 0
        if (Date.now() - revokedAt > REFRESH_REUSE_GRACE_MS) {
          const revokedCount = await revokeAllRefreshTokensForUser(revokedMatch.user_id, tx)
          await bumpTokenVersion(revokedMatch.user_id, tx)
          return { status: 'reused' as const, userId: revokedMatch.user_id, revokedCount }
        }
      }

      const liveToken = matched || (revokedMatch ? await findLiveRotationTip(revokedMatch, tx) : null)
      if (!liveToken) return { status: 'noop' as const }

      await revokeRefreshToken(liveToken.id, tx)
      await bumpTokenVersion(liveToken.user_id, tx)
      return { status: 'ok' as const }
    })

    if (outcome.status === 'reused') {
      console.warn(
        `Refresh token reuse detected on logout for user ${outcome.userId}; revoked ${outcome.revokedCount} active refresh token(s)`,
      )
      reply.clearCookie('refreshToken')
      reply.code(401).send({ message: 'Invalid refresh token' })
      return
    }
  }

  reply.clearCookie('refreshToken')
  return { message: 'Logged out' }
}
