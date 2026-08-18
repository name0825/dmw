import { AuthError, isValidJwtToken } from './auth.js'

/**
 * 요청의 Authorization 헤더에서 Bearer 토큰을 추출하고 JWT 검증 후
 * 해당 사용자 정보를 DB 에서 조회하여 요청 객체에 추가하는 미들웨어.
 * 토큰이 누락되거나 유효하지 않을 경우 401 응답을 반환함.
 * @param request - Fastify 요청 객체 (Authorization 헤더 포함)
 * @param reply - Fastify 응답 객체 (에러 응답을 보낼 때 사용)
 * @throws AuthError 토큰이 누락되거나, 서명이 잘못되었거나, 만료되었을 때
 */
export const authMiddleware = async (request: any, reply: any) => {
  const token = extractBearerToken(request.headers.authorization)

  if (!token) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }

  if (!isValidJwtToken(token)) {
    throw new AuthError('Invalid or expired token', 'INVALID_TOKEN', 401)
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string }
    const user = await db.get('SELECT id, email FROM users WHERE email = ?', [decoded.email])
    if (!user) {
      throw new AuthError('Invalid token', 'USER_NOT_FOUND', 401)
    }
    request.user = user
  } catch (err) {
    if (err instanceof AuthError) throw err
    reply.code(401).send({ message: 'Invalid or expired token' })
    return
  }
}
