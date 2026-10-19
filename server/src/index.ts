import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

import { BIND_HOST, CORS_ORIGIN, PORT, WEB_DEV_PORT, isProductionLike, validateRuntimeConfig } from './config.js'
import { RATE_LIMIT_TIME_WINDOW } from './config/constants.js'
import { initPool, closePool } from './database/index.js'
import { authMiddleware } from './middleware/auth.js'
import { isPublicRoute } from './auth.js'
import { registerRoutes, stopScheduler } from './routes.js'
import { setupWebSocket, closeWebSocket } from './services/ws.js'

// Only trust X-Forwarded-For when the immediate peer is loopback (i.e. nginx
// running on the same host via network_mode: host). Direct LAN clients are
// never loopback, so their IP is used as-is and headers can't be spoofed.
const app = Fastify({ logger: false, trustProxy: 'loopback' })

await app.register(cookie)
await app.register(cors, {
  origin: (origin, callback) => {
    const allowedOrigins = new Set(
      isProductionLike()
        ? CORS_ORIGIN
        : [...CORS_ORIGIN, `http://localhost:${WEB_DEV_PORT}`, `http://127.0.0.1:${WEB_DEV_PORT}`],
    )
    const isAllowed = !origin || allowedOrigins.has(origin)
    callback(null, isAllowed)
  },
  credentials: true,
})

await app.register(rateLimit, {
  max: 300,
  timeWindow: RATE_LIMIT_TIME_WINDOW,
  keyGenerator: (request: any) => request.ip,
  // statusCode 를 담지 않으면 Fastify 가 일반 에러로 처리해 500 을 내보낸다.
  // 한도 초과는 클라이언트가 재시도로 회복할 수 있는 상황이므로 429 여야 한다.
  errorResponseBuilder: (_request: any, context: any) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Too many requests, please try again in ${Math.ceil(context.ttl / 1000)}s`,
  }),
})

app.addHook('preHandler', async (request: any, reply) => {
  if (!isPublicRoute(request.url)) {
    await authMiddleware(request, reply)
  }
})

validateRuntimeConfig()

// DB 풀 초기화 및 admin 계정 생성
await initPool()

await registerRoutes(app)

await app.listen({ port: PORT, host: BIND_HOST })
setupWebSocket()
console.log(`DMW server listening on http://localhost:${PORT}`)

let isShuttingDown = false

// HTTP 먼저 닫아 새 요청을 막고, WS 로 실시간 연결을 끊은 뒤, 마지막에 DB 풀을 정리한다.
const shutdown = async (_signal: string) => {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('Shutting down...')

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, 10000)
  forceExitTimer.unref()

  let shutdownError: unknown
  try {
    stopScheduler()
    await app.close()
    await closeWebSocket()
    await closePool()
  } catch (err) {
    shutdownError = err
    console.error('Error during shutdown:', err)
  } finally {
    clearTimeout(forceExitTimer)
    process.exit(shutdownError ? 1 : 0)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
