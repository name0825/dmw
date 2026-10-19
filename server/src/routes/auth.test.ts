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
const { findRevokedRefreshTokenMatch, issueRefreshToken, revokeRefreshToken, pruneExpiredRefreshTokens } =
  await import('../database/auth.js')

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

test('refresh token whose user row was deleted is rejected without issuing new tokens', async () => {
  const db = getDb()
  const inserted = await db.run(
    'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
    ['ghost@example.com', 'unused-hash', 'user', new Date().toISOString()],
  )
  const userId = inserted.lastID as number
  const { token } = await issueRefreshToken(userId, db)
  await db.run('PRAGMA foreign_keys = OFF')
  try {
    await db.run('DELETE FROM users WHERE id = ?', [userId])
  } finally {
    await db.run('PRAGMA foreign_keys = ON')
  }

  const refreshReply = reply()
  await handleRefresh(requestWithCookie(token), refreshReply)

  assert.equal(refreshReply.status, 401)
  assert.equal(refreshReply.cookies.refreshToken, undefined)

  const row = await db.get('SELECT revoked FROM refresh_tokens WHERE user_id = ?', [userId])
  assert.equal(row.revoked, 1)
})

test('pruning deletes expired refresh tokens but keeps unexpired revoked ones', async () => {
  const db = getDb()
  const user = await db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])

  const expired = await issueRefreshToken(user.id, db)
  await db.run('UPDATE refresh_tokens SET expires_at = ? WHERE id = ?', [
    new Date(Date.now() - 60_000).toISOString(),
    expired.id,
  ])

  const revokedButLive = await issueRefreshToken(user.id, db)
  await revokeRefreshToken(revokedButLive.id, db)

  const deleted = await pruneExpiredRefreshTokens(db)
  assert.equal(deleted, 1)

  const expiredRow = await db.get('SELECT id FROM refresh_tokens WHERE id = ?', [expired.id])
  assert.equal(expiredRow, undefined)

  const revokedRow = await db.get('SELECT id, revoked FROM refresh_tokens WHERE id = ?', [revokedButLive.id])
  assert.ok(revokedRow)
  assert.equal(revokedRow.revoked, 1)
})

test('logout with a revoked refresh token outside the grace window is treated as reuse and kills every session', async () => {
  const { refreshToken } = await login()
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])

  const rotateReply = reply()
  await handleRefresh(requestWithCookie(refreshToken), rotateReply)
  assert.equal(rotateReply.status, 200)
  const liveToken = rotateReply.cookies.refreshToken
  assert.ok(liveToken)

  const revokedRow = await findRevokedRefreshTokenMatch(refreshToken, db)
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [
    new Date(Date.now() - 60_000).toISOString(),
    revokedRow.id,
  ])

  const logoutReply = reply()
  await handleLogout(requestWithCookie(refreshToken), logoutReply)
  assert.equal(logoutReply.status, 401)
  assert.deepEqual(logoutReply.body, { message: 'Invalid refresh token' })
  assert.ok(logoutReply.cleared.includes('refreshToken'))

  const liveTokens = await db.all('SELECT id FROM refresh_tokens WHERE user_id = ? AND revoked = 0', [user.id])
  assert.equal(liveTokens.length, 0)
  const userAfter = await db.get('SELECT token_version FROM users WHERE id = ?', [user.id])
  assert.equal(userAfter.token_version, user.token_version + 1)

  const successorReply = reply()
  await handleRefresh(requestWithCookie(liveToken), successorReply)
  assert.equal(successorReply.status, 401)
})

const loginFrom = (ip: string, email: string, password: string) => {
  const r = reply()
  return handleLogin({ ip, body: { email, password } }, r).then((result) => ({ r, result }))
}

test('login locks (email, IP) after repeated failures, even for the correct password, but not the same email from another IP', async () => {
  const { ACCOUNT_LOCK_THRESHOLD, resetPasswordThrottles } = await import('../auth.js')
  resetPasswordThrottles()
  try {
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) {
      const { r } = await loginFrom('10.0.0.1', ADMIN_EMAIL, 'wrong-password')
      assert.equal(r.status, 401)
    }

    const locked = await loginFrom('10.0.0.1', ADMIN_EMAIL.toUpperCase(), ADMIN_PASSWORD)
    assert.equal(locked.r.status, 429)
    assert.equal((locked.result as any)?.accessToken, undefined)
    assert.equal(locked.r.cookies.refreshToken, undefined)

    const otherIp = await loginFrom('10.0.0.2', ADMIN_EMAIL, ADMIN_PASSWORD)
    assert.equal(otherIp.r.status, 200)
    assert.ok((otherIp.result as any)?.accessToken)

    const unknown = 'nobody@dmw.local'
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) await loginFrom('10.0.0.1', unknown, 'x')
    assert.equal((await loginFrom('10.0.0.1', unknown, 'x')).r.status, 429)
  } finally {
    resetPasswordThrottles()
  }
})

test('login lock backs off exponentially and expires', async () => {
  const { ACCOUNT_LOCK_THRESHOLD, beginLoginAttempt, resetPasswordThrottles } = await import('../auth.js')
  resetPasswordThrottles()
  try {
    const now = Date.now()
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) {
      assert.equal(beginLoginAttempt('backoff@dmw.local', '10.0.0.1', now).lockedMs, 0)
    }
    const first = beginLoginAttempt('backoff@dmw.local', '10.0.0.1', now).lockedMs
    assert.ok(first > 0)
    const later = now + first + 1
    assert.equal(beginLoginAttempt('backoff@dmw.local', '10.0.0.1', later).lockedMs, 0)
    const second = beginLoginAttempt('backoff@dmw.local', '10.0.0.1', later).lockedMs
    assert.ok(second > first, 'backoff grows beyond the base lock')
  } finally {
    resetPasswordThrottles()
  }
})

test('the per-email ceiling locks an email across many IPs', async () => {
  const { EMAIL_FAILURE_CEILING, beginLoginAttempt, resetPasswordThrottles } = await import('../auth.js')
  resetPasswordThrottles()
  try {
    const now = Date.now()
    for (let i = 0; i < EMAIL_FAILURE_CEILING; i += 1) {
      assert.equal(beginLoginAttempt('victim@dmw.local', `10.1.${Math.floor(i / 250)}.${i % 250}`, now).lockedMs, 0)
    }
    const blocked = beginLoginAttempt('victim@dmw.local', '10.9.9.9', now)
    assert.ok(blocked.lockedMs > 0)
    assert.equal(beginLoginAttempt('victim@dmw.local', '10.9.9.9', now + 60 * 60 * 1000 + 1).lockedMs, 0)
    assert.equal(beginLoginAttempt('other@dmw.local', '10.9.9.9', now).lockedMs, 0)
  } finally {
    resetPasswordThrottles()
  }
})

test('a failure is counted before the password check so concurrent logins cannot all pass a lapsed lock', async () => {
  const { ACCOUNT_LOCK_THRESHOLD, beginLoginAttempt, resetPasswordThrottles } = await import('../auth.js')
  resetPasswordThrottles()
  try {
    const now = Date.now()
    const results = Array.from({ length: ACCOUNT_LOCK_THRESHOLD + 3 }, () => beginLoginAttempt('race@dmw.local', '10.0.0.1', now))
    assert.equal(results.filter((attempt) => attempt.lockedMs === 0).length, ACCOUNT_LOCK_THRESHOLD)
  } finally {
    resetPasswordThrottles()
  }
})

test('SSH re-confirm and login throttles are independent', async () => {
  const { ACCOUNT_LOCK_THRESHOLD, beginSshConfirmAttempt, resetPasswordThrottles } = await import('../auth.js')
  resetPasswordThrottles()
  try {
    const user = await getDb().get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) assert.equal(beginSshConfirmAttempt(user.id).lockedMs, 0)
    assert.ok(beginSshConfirmAttempt(user.id).lockedMs > 0)
    assert.equal(beginSshConfirmAttempt(user.id + 1).lockedMs, 0)
    const ok = await loginFrom('10.0.0.1', ADMIN_EMAIL, ADMIN_PASSWORD)
    assert.equal(ok.r.status, 200)

    resetPasswordThrottles()
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) await loginFrom('10.0.0.1', ADMIN_EMAIL, 'wrong-password')
    assert.equal((await loginFrom('10.0.0.1', ADMIN_EMAIL, ADMIN_PASSWORD)).r.status, 429)
    assert.equal(beginSshConfirmAttempt(user.id).lockedMs, 0)
  } finally {
    resetPasswordThrottles()
  }
})

test('throttle eviction never drops a locked entry and fails closed only for the new key when all are locked', async () => {
  const { ACCOUNT_LOCK_THRESHOLD, ACCOUNT_THROTTLE_MAX_ENTRIES, beginSshConfirmAttempt, resetPasswordThrottles } =
    await import('../auth.js')
  resetPasswordThrottles()
  try {
    const now = Date.now()
    const lock = (id: number) => {
      for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) beginSshConfirmAttempt(id, now)
    }
    lock(1)
    for (let id = 2; id <= ACCOUNT_THROTTLE_MAX_ENTRIES + 50; id += 1) beginSshConfirmAttempt(id, now)
    assert.ok(beginSshConfirmAttempt(1, now).lockedMs > 0, 'locked entry survives eviction pressure')

    resetPasswordThrottles()
    for (let id = 1; id <= ACCOUNT_THROTTLE_MAX_ENTRIES; id += 1) lock(id)
    const fresh = beginSshConfirmAttempt(ACCOUNT_THROTTLE_MAX_ENTRIES + 1, now)
    assert.ok(fresh.lockedMs > 0, 'untrackable new key is refused')
    for (const id of [1, 5000, ACCOUNT_THROTTLE_MAX_ENTRIES]) {
      assert.ok(beginSshConfirmAttempt(id, now).lockedMs > 0, `locked entry ${id} still locked`)
    }
    assert.equal(beginSshConfirmAttempt(ACCOUNT_THROTTLE_MAX_ENTRIES + 1, now + 24 * 60 * 60 * 1000).lockedMs, 0)
  } finally {
    resetPasswordThrottles()
  }
})
