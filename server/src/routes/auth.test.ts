import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-refresh-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('../database/index.js')
const { ADMIN_EMAIL, ADMIN_PASSWORD } = await import('../config.js')
const { handleLogin, handleRefresh, handleLogout } = await import('./auth.js')
const { authMiddleware } = await import('../auth.js')
const { findRevokedRefreshTokenMatch } = await import('../database/auth.js')

type Reply = {
  status: number
  body?: unknown
  cookies: Record<string, string>
  cleared: string[]
  code: (status: number) => Reply
  send: (body: unknown) => Reply
  setCookie: (name: string, value: string) => Reply
  clearCookie: (name: string) => Reply
}

const reply = (): Reply => ({
  status: 200,
  cookies: {},
  cleared: [],
  code(status) {
    this.status = status
    return this
  },
  send(body) {
    this.body = body
    return this
  },
  setCookie(name, value) {
    this.cookies[name] = value
    return this
  },
  clearCookie(name) {
    this.cleared.push(name)
    return this
  },
})

const requestWithCookie = (refreshToken?: string) => ({
  cookies: refreshToken ? { refreshToken } : {},
})

const login = async () => {
  const loginReply = reply()
  const result = await handleLogin({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }, loginReply)
  const accessToken = (result as any)?.accessToken
  const refreshToken = loginReply.cookies.refreshToken
  assert.ok(accessToken, 'login should issue an access token')
  assert.ok(refreshToken, 'login should issue a refresh token cookie')
  return { accessToken, refreshToken }
}

beforeEach(async () => {
  await initPool()
  const db = getDb()
  await db.exec('DELETE FROM refresh_tokens;')
  await db.run('UPDATE users SET token_version = 0 WHERE email = ?', [ADMIN_EMAIL])
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('duplicate refresh with the same cookie (multi-tab) both succeed with exactly one live token and no version bump', async () => {
  const { refreshToken } = await login()
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])

  const reply1 = reply()
  const result1 = await handleRefresh(requestWithCookie(refreshToken), reply1)
  assert.equal(reply1.status, 200)
  assert.ok((result1 as any)?.accessToken)

  const reply2 = reply()
  const result2 = await handleRefresh(requestWithCookie(refreshToken), reply2)
  assert.equal(reply2.status, 200)
  assert.ok((result2 as any)?.accessToken)

  const liveTokens = await db.all(
    'SELECT id FROM refresh_tokens WHERE user_id = ? AND revoked = 0',
    [user.id],
  )
  assert.equal(liveTokens.length, 1)

  const userAfter = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfter.token_version, user.token_version)
})

test('revoked refresh token replayed outside the grace window triggers full invalidation', async () => {
  const { refreshToken } = await login()
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])

  const rotateReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), rotateReply)
  assert.equal(rotateReply.status, 200)

  const revokedRow = await findRevokedRefreshTokenMatch(refreshToken, db)
  assert.ok(revokedRow, 'the original login token should now be revoked')
  const staleTimestamp = new Date(Date.now() - 60_000).toISOString()
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [staleTimestamp, revokedRow.id])

  const replayReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), replayReply)

  assert.equal(replayReply.status, 401)
  assert.deepEqual(replayReply.body, { message: 'Invalid refresh token' })
  assert.ok(replayReply.cleared.includes('refreshToken'))

  const liveTokens = await db.all(
    'SELECT id FROM refresh_tokens WHERE user_id = ? AND revoked = 0',
    [user.id],
  )
  assert.equal(liveTokens.length, 0)

  const userAfter = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfter.token_version, user.token_version + 1)
})

test('token_version bump after reuse detection revokes previously issued access tokens', async () => {
  const { accessToken, refreshToken } = await login()
  const db = getDb()

  const preCheck = reply()
  await authMiddleware({ headers: { authorization: `Bearer ${accessToken}` } }, preCheck)
  assert.equal(preCheck.status, 200)

  const rotateReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), rotateReply)
  const revokedRow = await findRevokedRefreshTokenMatch(refreshToken, db)
  await db.run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?',
    [new Date(Date.now() - 60_000).toISOString(), revokedRow.id],
  )
  const replayReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), replayReply)
  assert.equal(replayReply.status, 401)

  const authReply = reply()
  await authMiddleware({ headers: { authorization: `Bearer ${accessToken}` } }, authReply)
  assert.equal(authReply.status, 401)
})

test('refresh after logout yields a plain 401 without wiping other sessions', async () => {
  const { refreshToken } = await login()
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])

  const logoutReply = reply()
  const logoutResult = await handleLogout(requestWithCookie(refreshToken), logoutReply)
  assert.deepEqual(logoutResult, { message: 'Logged out' })

  const userAfterLogout = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfterLogout.token_version, user.token_version + 1)

  const replayReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), replayReply)
  assert.equal(replayReply.status, 401)
  assert.deepEqual(replayReply.body, { message: 'Invalid refresh token' })

  const userAfterReplay = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfterReplay.token_version, user.token_version + 1)
})

test('logout with a rotated token revokes its live successor', async () => {
  const { refreshToken } = await login()
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])

  const refreshReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), refreshReply)
  assert.equal(refreshReply.status, 200)
  const successor = refreshReply.cookies.refreshToken
  assert.ok(successor)

  const logoutReply = reply()
  await handleLogout(requestWithCookie(refreshToken), logoutReply)

  const successorReply = reply()
  await handleRefresh(requestWithCookie(successor), successorReply)
  assert.equal(successorReply.status, 401)

  const liveTokens = await db.all(
    'SELECT id FROM refresh_tokens WHERE user_id = ? AND revoked = 0',
    [user.id],
  )
  assert.equal(liveTokens.length, 0)

  const userAfter = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfter.token_version, user.token_version + 1)
})
