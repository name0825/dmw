import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

import { CORS_ORIGIN, PORT, validateRuntimeConfig } from './config.js'
import { initPool, closePool } from './database/index.js'
import { authMiddleware, isPublicRoute } from './middleware/auth.js'
import { registerRoutes } from './routes.js'

const app = Fastify({ logger: false })

await app.register(cookie)
await app.register(cors, {
  origin: (origin, callback) => {
    const allowedOrigins = new Set([...CORS_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'])
    const isAllowed = !origin || allowedOrigins.has(origin)
    callback(null, isAllowed)
  },
  credentials: true,
})

await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (request: any) => request.ip,
  errorResponseBuilder: (_request: any, context: any) => ({
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
const pool = initPool()
await pool.then((db: any) => db.run('PRAGMA foreign_keys = ON'))

await registerRoutes(app)

await app.listen({ port: PORT, host: '0.0.0.0' })
setupWebSocket(app.server)
console.log(`DMW server listening on http://localhost:${PORT}`)

process.on('beforeExit', () => {
  console.log('Shutting down...')
  closePool()
  app.close()
})
