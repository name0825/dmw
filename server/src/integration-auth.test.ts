import test, { after, beforeEach, mock } from 'node:test'
import bcrypt from 'bcryptjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-auth-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL, ADMIN_PASSWORD } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute } = await import('./auth.js')
const { registerAuthRoutes } = await import('./routes/auth.js')
const { registerDeviceRoutes } = await import('./routes/devices.js')

const buildApp = async () => {
  const app = Fastify()
  await app.register(cookie)
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerAuthRoutes(app)
  registerDeviceRoutes(app)
  return app
}

const getRefreshCookie = (response: any): string => {
  const match = response.cookies.find((c: any) => c.name === 'refreshToken')
  return match?.value || ''
}

beforeEach(async () => {
  await initPool()
  const db = getDb()
  await db.exec('DELETE FROM refresh_tokens; DELETE FROM devices;')
  await db.run('UPDATE users SET token_version = 0 WHERE email = ?', [ADMIN_EMAIL])
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('login with correct credentials succeeds and returns an access token plus a refresh token cookie', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    assert.equal(response.statusCode, 200)
    assert.ok(response.json().accessToken)
    assert.ok(getRefreshCookie(response), 'refresh token cookie should be set')
  } finally {
    await app.close()
  }
})

test('login with wrong password is rejected', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'wrong-password' },
    })
    assert.equal(response.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('login with a non-string password or email is rejected with 400', async () => {
  const app = await buildApp()
  try {
    const payloads = [
      { email: ADMIN_EMAIL, password: 12345 },
      { email: ADMIN_EMAIL, password: { $ne: '' } },
      { email: ADMIN_EMAIL, password: ['a'] },
      { email: 123, password: 'x' },
      { email: { $ne: '' }, password: 'x' },
      { email: ADMIN_EMAIL, password: '' },
    ]
    for (const payload of payloads) {
      const response = await app.inject({ method: 'POST', url: '/auth/login', payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
    }
  } finally {
    await app.close()
  }
})

test('login with an unknown email runs bcrypt.compare and returns the same 401 as a wrong password', async () => {
  const app = await buildApp()
  const compareSpy = mock.method(bcrypt, 'compare')
  try {
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.invalid', password: 'whatever' },
    })
    assert.equal(compareSpy.mock.callCount(), 1)
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'wrong-password' },
    })
    assert.equal(unknown.statusCode, 401)
    assert.equal(wrong.statusCode, 401)
    assert.equal(unknown.body, wrong.body)
  } finally {
    compareSpy.mock.restore()
    await app.close()
  }
})

test('the admin password is not stored in plaintext', async () => {
  const db = getDb()
  const user = await db.get('SELECT password_hash FROM users WHERE email = ?', [ADMIN_EMAIL])
  assert.notEqual(user.password_hash, ADMIN_PASSWORD)
  assert.match(user.password_hash, /^\$2[aby]\$/)
})

test('refresh issues a new access token from the login refresh cookie', async () => {
  const app = await buildApp()
  try {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    const refreshToken = getRefreshCookie(loginResponse)

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refreshToken },
    })
    assert.equal(refreshResponse.statusCode, 200)
    assert.ok(refreshResponse.json().accessToken)
  } finally {
    await app.close()
  }
})

test('logout invalidates the refresh token so it cannot be reused', async () => {
  const app = await buildApp()
  try {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    const refreshToken = getRefreshCookie(loginResponse)

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { refreshToken },
    })
    assert.equal(logoutResponse.statusCode, 200)

    const reuseResponse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refreshToken },
    })
    assert.equal(reuseResponse.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('an invalid access token is rejected on a protected route', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/devices',
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    assert.equal(response.statusCode, 401)
  } finally {
    await app.close()
  }
})
