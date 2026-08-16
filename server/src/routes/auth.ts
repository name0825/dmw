import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

import { ADMIN_EMAIL, COOKIE_SECURE } from '../config.js'
import { db } from '../db.js'
import { createToken, findRefreshTokenMatch, getRefreshLookupId, revokeRefreshToken } from '../auth.js'

// 리프레시 토큰 유효기간 (7일). 쿠키 maxAge와 DB expires_at에 동일하게 사용된다.
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }
const REFRESH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' }

/**
 * 리프레시 토큰을 생성해 DB에 저장하고 httpOnly 쿠키로 설정한다.
 * 토큰 원문은 저장하지 않고 bcrypt 해시만 저장하며, 빠른 인덱스 조회를
 * 위해 16자 접두(lookup_id)를 함께 저장한다.
 * @param {any} reply - Fastify reply 객체
 * @param {number} userId - 토큰 소유자 user id
 */
const issueRefreshToken = async (reply: any, userId: number) => {
  const refreshToken = randomBytes(32).toString('hex')
  const refreshHash = await bcrypt.hash(refreshToken, 10)
  const lookupId = getRefreshLookupId(refreshToken)
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()

  await db.run(
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
 * 쿠키 또는 바디에서 리프레시 토큰을 추출한다.
 * 바디 우선순위는 기존 동작(바디가 있으면 쿠키보다 우선)을 보존한다.
 * @param {any} request - Fastify request 객체
 * @returns {string} 리프레시 토큰 (없으면 빈 문자열)
 */
const extractRefreshToken = (request: any): string => {
  const cookieToken = request.cookies?.refreshToken || ''
  const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken || ''
  return bodyToken || cookieToken
}

/**
 * 인증 관련 라우트(/auth/login, /auth/refresh, /auth/logout)를 등록한다.
 * @param {any} app - Fastify app 인스턴스
 */
export const registerAuthRoutes = (app: any) => {
  app.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request: any, reply: any) => {
    const { email, password } = (request.body || {}) as { email?: string; password?: string }
    if (!email || !password) {
      reply.code(400).send({ message: 'Email and password are required' })
      return
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email])
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
  })

  app.post('/auth/refresh', { config: { rateLimit: REFRESH_RATE_LIMIT } }, async (request: any, reply: any) => {
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
      await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
      reply.code(401).send({ message: 'Refresh token expired' })
      return
    }

    const user = await db.get('SELECT id, email FROM users WHERE id = ?', [matched.user_id])
    // NOTE: user 행이 사라진 경우에도 기존 동작상 ADMIN_EMAIL로 토큰을 발급한다.
    // 의도된 fallback인지 확인이 필요하며, 이번 리팩토링에서는 동작을 보존한다.
    const email = user?.email || ADMIN_EMAIL
    const accessToken = createToken(email)

    // 기존 토큰을 폐기하고 새 토큰으로 교체(로테이션)한다.
    await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [matched.id])
    await issueRefreshToken(reply, matched.user_id)

    return { accessToken }
  })

  app.post('/auth/logout', async (_request: any, reply: any) => {
    const refreshToken = extractRefreshToken(_request)

    if (refreshToken) {
      await revokeRefreshToken(refreshToken)
    }

    reply.clearCookie('refreshToken')
    return { message: 'Logged out' }
  })
}
