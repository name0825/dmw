import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-integration-ssh-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL, ADMIN_PASSWORD, SSH_KEY_PATH } = await import('./config.js')
const { authMiddleware } = await import('./middleware/auth.js')
const { isPublicRoute, createToken, resetPasswordThrottles, ACCOUNT_LOCK_THRESHOLD } = await import('./auth.js')
const { registerSshRoutes } = await import('./routes/ssh.js')
const { SshError } = await import('./services/ssh.js')
type ExecRequest = import('./services/ssh.js').ExecRequest
type ExecResult = import('./services/ssh.js').ExecResult

const TRUSTED = `SHA256:${'A'.repeat(43)}`
const PRESENTED_BY_ATTACKER = `SHA256:${'B'.repeat(43)}`

type ExecImpl = (request: ExecRequest) => Promise<ExecResult>

const okResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  exitCode: 0,
  signal: null,
  stdout: 'hello\n',
  stderr: '',
  truncated: false,
  ...overrides,
})

const makeTransport = (impl: ExecImpl = async () => okResult()) => {
  const calls: ExecRequest[] = []
  return {
    calls,
    transport: {
      scanHostKey: async () => TRUSTED,
      exec: async (request: ExecRequest) => {
        calls.push(request)
        return impl(request)
      },
    },
  }
}

const buildApp = (transport: ReturnType<typeof makeTransport>['transport']) => {
  const app = Fastify()
  app.addHook('preHandler', async (request: any, reply: any) => {
    if (!isPublicRoute(request.url)) await authMiddleware(request, reply)
  })
  registerSshRoutes(app, { transport })
  return app
}

const adminAuthHeader = async () => {
  const admin = await getDb().get('SELECT token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  return { authorization: `Bearer ${createToken(ADMIN_EMAIL, admin.token_version ?? 0)}` }
}

let macCounter = 0
const insertDevice = async (
  overrides: { username?: string | null; hostKey?: string | null; hostIp?: string | null } = {},
) => {
  macCounter += 1
  const username = overrides.username === undefined ? 'root' : overrides.username
  const hostKey = overrides.hostKey === undefined ? TRUSTED : overrides.hostKey
  const ip = `127.0.1.${macCounter}`
  const hostIp = overrides.hostIp === undefined ? (hostKey ? ip : null) : overrides.hostIp
  const inserted = await getDb().run(
    'INSERT INTO devices (name, mac_address, ip_address, status, ssh_username, ssh_port, ssh_host_key, ssh_host_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`Device ${macCounter}`, `AA:BB:CC:00:00:${String(macCounter).padStart(2, '0')}`, ip, 'ONLINE', username, username ? 22 : null, hostKey, hostIp],
  )
  return inserted.lastID as number
}

const deviceIp = async (deviceId: number): Promise<string> =>
  (await getDb().get('SELECT ip_address FROM devices WHERE id = ?', [deviceId])).ip_address

const userAuthHeader = async () => {
  await getDb().run(
    "INSERT OR IGNORE INTO users (email, password_hash, role) VALUES ('plain@dmw.local', 'x', 'user')",
  )
  const user = await getDb().get("SELECT token_version FROM users WHERE email = 'plain@dmw.local'")
  return { authorization: `Bearer ${createToken('plain@dmw.local', user.token_version ?? 0)}` }
}

const runCommandRequest = async (
  app: ReturnType<typeof buildApp>,
  deviceId: number,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `/devices/${deviceId}/commands`,
    headers: await adminAuthHeader(),
    payload: body,
  })

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), 'condition was not met in time')
}

beforeEach(async () => {
  await initPool()
  await getDb().exec('DELETE FROM command_runs; DELETE FROM ssh_audit; DELETE FROM devices;')
})

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('SSH routes require a valid JWT', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const post = await app.inject({ method: 'POST', url: `/devices/${deviceId}/commands`, payload: { command: 'uptime', password: ADMIN_PASSWORD } })
    assert.equal(post.statusCode, 401)
    const key = await app.inject({ method: 'GET', url: '/ssh/public-key' })
    assert.equal(key.statusCode, 401)
    assert.equal(calls.length, 0)
  } finally {
    await app.close()
  }
})

test('public key endpoint returns an OpenSSH public key and never the private key', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const first = await app.inject({ method: 'GET', url: '/ssh/public-key', headers: await adminAuthHeader() })
    assert.equal(first.statusCode, 200)
    assert.match(first.json().publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ dmw-server$/)
    assert.ok(!first.body.includes('PRIVATE'))

    const second = await app.inject({ method: 'GET', url: '/ssh/public-key', headers: await adminAuthHeader() })
    assert.equal(second.json().publicKey, first.json().publicKey)
    assert.ok(fs.existsSync(SSH_KEY_PATH))
  } finally {
    await app.close()
  }
})

test('a wrong admin password returns 403, is audited, and never reaches the SSH transport', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const response = await runCommandRequest(app, deviceId, { command: 'reboot', password: 'not-the-password' })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.json(), { message: 'Password confirmation failed' })
    assert.equal(calls.length, 0)
    const rows = await getDb().all('SELECT id FROM command_runs')
    assert.equal(rows.length, 0)
    const audit = await getDb().all('SELECT event, device_id FROM ssh_audit')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].event, 'command_reauth_failed')
    assert.equal(audit[0].device_id, deviceId)
  } finally {
    await app.close()
  }
})

test('missing, oversized, and NUL-containing commands are rejected with 400', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    for (const body of [
      { password: ADMIN_PASSWORD },
      { command: '   ', password: ADMIN_PASSWORD },
      { command: 'a'.repeat(1025), password: ADMIN_PASSWORD },
      { command: 'ls\0', password: ADMIN_PASSWORD },
      { command: 'ls' },
    ]) {
      const response = await runCommandRequest(app, deviceId, body)
      assert.equal(response.statusCode, 400)
    }
    assert.equal(calls.length, 0)
  } finally {
    await app.close()
  }
})

test('a device without SSH settings or without a confirmed host key returns 409 without connecting', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const unconfigured = await insertDevice({ username: null, hostKey: null })
    const unconfirmed = await insertDevice({ hostKey: null })
    for (const deviceId of [unconfigured, unconfirmed]) {
      const response = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
      assert.equal(response.statusCode, 409)
    }
    assert.equal(calls.length, 0)
  } finally {
    await app.close()
  }
})

test('saving SSH settings requires an explicit, well-formed host key fingerprint', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice({ username: null, hostKey: null })
    const headers = await adminAuthHeader()
    const ip = await deviceIp(deviceId)

    for (const payload of [
      { username: 'root', port: 22, password: ADMIN_PASSWORD },
      { username: 'root', port: 22, hostKeyFingerprint: 'SHA256:short', password: ADMIN_PASSWORD },
      { username: 'root; rm -rf /', port: 22, hostKeyFingerprint: TRUSTED, password: ADMIN_PASSWORD },
      { username: 'root', port: 70000, hostKeyFingerprint: TRUSTED, password: ADMIN_PASSWORD },
    ]) {
      const bad = await app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { hostKeyIp: ip, ...payload } })
      assert.equal(bad.statusCode, 400)
    }
    const noIp = await app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { username: 'root', port: 22, hostKeyFingerprint: TRUSTED, password: ADMIN_PASSWORD } })
    assert.equal(noIp.statusCode, 400)
    let row = await getDb().get('SELECT ssh_username, ssh_host_key FROM devices WHERE id = ?', [deviceId])
    assert.equal(row.ssh_username, null)
    assert.equal(row.ssh_host_key, null)

    const scan = await app.inject({ method: 'POST', url: `/devices/${deviceId}/ssh/scan`, headers, payload: { port: 22 } })
    assert.equal(scan.statusCode, 200)
    assert.equal(scan.json().fingerprint, TRUSTED)
    assert.equal(scan.json().ip, ip)
    row = await getDb().get('SELECT ssh_host_key FROM devices WHERE id = ?', [deviceId])
    assert.equal(row.ssh_host_key, null)

    const saved = await app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { username: 'admin', port: 2222, hostKeyFingerprint: TRUSTED, hostKeyIp: ip, password: ADMIN_PASSWORD } })
    assert.equal(saved.statusCode, 200)
    row = await getDb().get('SELECT ssh_username, ssh_port, ssh_host_key, ssh_host_ip FROM devices WHERE id = ?', [deviceId])
    assert.deepEqual({ ...row }, { ssh_username: 'admin', ssh_port: 2222, ssh_host_key: TRUSTED, ssh_host_ip: ip })

    const removed = await app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers, payload: { password: ADMIN_PASSWORD } })
    assert.equal(removed.statusCode, 200)
    row = await getDb().get('SELECT ssh_username, ssh_host_key FROM devices WHERE id = ?', [deviceId])
    assert.equal(row.ssh_username, null)
    assert.equal(row.ssh_host_key, null)
  } finally {
    await app.close()
  }
})

test('changing or clearing SSH settings requires the admin password (400 missing, 403 wrong) and audits failures', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const headers = await adminAuthHeader()
    const settings = { username: 'admin', port: 2222, hostKeyFingerprint: PRESENTED_BY_ATTACKER, hostKeyIp: await deviceIp(deviceId) }

    for (const extra of [{}, { password: '' }]) {
      const put = await app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { ...settings, ...extra } })
      assert.equal(put.statusCode, 400)
      const del = await app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers, payload: extra })
      assert.equal(del.statusCode, 400)
    }

    const wrongPut = await app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { ...settings, password: 'nope' } })
    assert.equal(wrongPut.statusCode, 403)
    const wrongDel = await app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers, payload: { password: 'nope' } })
    assert.equal(wrongDel.statusCode, 403)

    const row = await getDb().get('SELECT ssh_username, ssh_port, ssh_host_key FROM devices WHERE id = ?', [deviceId])
    assert.deepEqual({ ...row }, { ssh_username: 'root', ssh_port: 22, ssh_host_key: TRUSTED })

    const audit = await getDb().all('SELECT event, device_id FROM ssh_audit ORDER BY id')
    assert.deepEqual(audit.map((r: any) => r.event), ['config_reauth_failed', 'config_reauth_failed'])
    assert.ok(audit.every((r: any) => r.device_id === deviceId))
  } finally {
    await app.close()
  }
})

test('successful SSH config changes write config_set and config_clear audit rows with old and new values', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const headers = await adminAuthHeader()
    const newFingerprint = `SHA256:${'C'.repeat(43)}`

    const put = await app.inject({
      method: 'PUT',
      url: `/devices/${deviceId}/ssh`,
      headers,
      payload: { username: 'admin', port: 2222, hostKeyFingerprint: newFingerprint, hostKeyIp: await deviceIp(deviceId), password: ADMIN_PASSWORD },
    })
    assert.equal(put.statusCode, 200)
    const set = await getDb().get("SELECT * FROM ssh_audit WHERE event = 'config_set'")
    assert.equal(set.device_id, deviceId)
    assert.ok(set.user_id)
    assert.equal(set.old_username, 'root')
    assert.equal(set.old_port, 22)
    assert.equal(set.old_fingerprint, TRUSTED)
    assert.equal(set.new_username, 'admin')
    assert.equal(set.new_port, 2222)
    assert.equal(set.new_fingerprint, newFingerprint)

    const del = await app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers, payload: { password: ADMIN_PASSWORD } })
    assert.equal(del.statusCode, 200)
    const clear = await getDb().get("SELECT * FROM ssh_audit WHERE event = 'config_clear'")
    assert.equal(clear.device_id, deviceId)
    assert.equal(clear.old_username, 'admin')
    assert.equal(clear.old_port, 2222)
    assert.equal(clear.old_fingerprint, newFingerprint)
    assert.equal(clear.new_username, null)
    assert.equal(clear.new_port, null)
    assert.equal(clear.new_fingerprint, null)
  } finally {
    await app.close()
  }
})

test('a successful run returns the output and writes exactly one audit row matching the response', async () => {
  const { transport, calls } = makeTransport(async () => okResult({ stdout: 'up 3 days\n', stderr: 'warn\n' }))
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const response = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.exitCode, 0)
    assert.equal(body.stdout, 'up 3 days\n')
    assert.equal(body.truncated, false)
    assert.ok(!response.body.includes('PRIVATE KEY'))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'uptime')
    assert.equal(calls[0].username, 'root')
    assert.equal(calls[0].expectedFingerprint, TRUSTED)

    const rows = await getDb().all('SELECT * FROM command_runs')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, body.runId)
    assert.equal(rows[0].device_id, deviceId)
    assert.equal(rows[0].command, 'uptime')
    assert.equal(rows[0].exit_code, 0)
    assert.equal(rows[0].stdout, 'up 3 days\n')
    assert.equal(rows[0].error, null)
    assert.ok(rows[0].finished_at)
    assert.ok(!JSON.stringify(rows[0]).includes('PRIVATE KEY'))
  } finally {
    await app.close()
  }
})

test('a host key that does not match the trusted fingerprint is rejected with 409 and audited', async () => {
  const { transport } = makeTransport(async (request) => {
    if (request.expectedFingerprint !== PRESENTED_BY_ATTACKER) {
      throw new SshError('HOST_KEY_MISMATCH', 'Host key does not match the trusted fingerprint')
    }
    throw new Error('the mismatching host key must never be accepted')
  })
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const response = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(response.statusCode, 409)
    assert.ok(response.json().runId)

    const rows = await getDb().all('SELECT exit_code, stdout, error, finished_at FROM command_runs')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].exit_code, null)
    assert.match(rows[0].error, /host key/i)
    assert.ok(rows[0].finished_at)
  } finally {
    await app.close()
  }
})

test('a timeout returns 504, keeps partial output, and still writes the audit row', async () => {
  const { transport } = makeTransport(async () => {
    const error = new SshError('TIMEOUT', 'Command timed out')
    error.stdout = 'partial'
    throw error
  })
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const response = await runCommandRequest(app, deviceId, { command: 'sleep 60', password: ADMIN_PASSWORD })
    assert.equal(response.statusCode, 504)

    const rows = await getDb().all('SELECT stdout, error, finished_at FROM command_runs')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stdout, 'partial')
    assert.equal(rows[0].error, 'Command timed out')
    assert.ok(rows[0].finished_at)
  } finally {
    await app.close()
  }
})

test('unexpected transport failures return 502 without leaking details and free the slot', async () => {
  let attempt = 0
  const { transport } = makeTransport(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('boom /secret/path')
    return okResult()
  })
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const failed = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(failed.statusCode, 502)
    assert.ok(!failed.body.includes('secret'))
    const rows = await getDb().all('SELECT error FROM command_runs')
    assert.ok(!JSON.stringify(rows).includes('secret'))

    const retried = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(retried.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('output beyond the limit is cut and flagged as truncated', async () => {
  const { transport } = makeTransport(async () => okResult({ stdout: 'x'.repeat(70 * 1024), stderr: 'e'.repeat(70 * 1024) }))
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const response = await runCommandRequest(app, deviceId, { command: 'yes', password: ADMIN_PASSWORD })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.truncated, true)
    assert.equal(body.stdout.length, 64 * 1024)
    assert.equal(body.stderr.length, 64 * 1024)

    const row = await getDb().get('SELECT truncated, length(stdout) AS size FROM command_runs')
    assert.equal(row.truncated, 1)
    assert.equal(row.size, 64 * 1024)
  } finally {
    await app.close()
  }
})

test('a second concurrent command on the same device is rejected with 429 until the first finishes', async () => {
  let release: (result: ExecResult) => void = () => {}
  const { transport, calls } = makeTransport(
    () => new Promise<ExecResult>((resolve) => {
      release = resolve
    }),
  )
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const first = runCommandRequest(app, deviceId, { command: 'sleep 5', password: ADMIN_PASSWORD })
    await waitFor(() => calls.length === 1)

    const second = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(second.statusCode, 429)
    assert.equal(calls.length, 1)

    release(okResult())
    assert.equal((await first).statusCode, 200)

    const third = runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    await waitFor(() => calls.length === 2)
    release(okResult())
    assert.equal((await third).statusCode, 200)
  } finally {
    await app.close()
  }
})

test('more than four commands across devices are rejected with 429', async () => {
  const releases: Array<(result: ExecResult) => void> = []
  const { transport, calls } = makeTransport(
    () => new Promise<ExecResult>((resolve) => {
      releases.push(resolve)
    }),
  )
  const app = buildApp(transport)
  try {
    const pending = []
    for (let i = 0; i < 4; i += 1) {
      const deviceId = await insertDevice()
      pending.push(runCommandRequest(app, deviceId, { command: 'sleep 5', password: ADMIN_PASSWORD }))
    }
    await waitFor(() => calls.length === 4)

    const fifthDevice = await insertDevice()
    const rejected = await runCommandRequest(app, fifthDevice, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(rejected.statusCode, 429)
    assert.equal(calls.length, 4)

    releases.forEach((release) => release(okResult()))
    for (const response of await Promise.all(pending)) assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('audit rows survive device deletion and the history endpoint lists recent runs', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    await runCommandRequest(app, deviceId, { command: 'df -h', password: ADMIN_PASSWORD })

    const list = await app.inject({ method: 'GET', url: `/devices/${deviceId}/commands?limit=1`, headers: await adminAuthHeader() })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().runs.length, 1)
    assert.equal(list.json().runs[0].command, 'df -h')

    await getDb().run('DELETE FROM devices WHERE id = ?', [deviceId])
    const rows = await getDb().all('SELECT device_id, device_name, command FROM command_runs ORDER BY id')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].device_id, null)
    assert.equal(rows[0].device_name, `Device ${macCounter}`)
  } finally {
    await app.close()
  }
})

test('exec is refused with 409 when the device IP differs from the IP its host key was pinned to', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice({ hostIp: '10.9.9.9' })
    const response = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().message, /re-scan/i)
    assert.equal(calls.length, 0)
    assert.equal((await getDb().all('SELECT id FROM command_runs')).length, 0)

    const legacy = await insertDevice({ hostIp: null })
    const legacyResponse = await runCommandRequest(app, legacy, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(legacyResponse.statusCode, 409)
    assert.equal(calls.length, 0)

    await getDb().run('UPDATE devices SET ip_address = ssh_host_ip WHERE id = ?', [deviceId])
    const ok = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(ok.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].host, '10.9.9.9')
  } finally {
    await app.close()
  }
})

test('saving SSH settings is rejected when the device IP changed since the scan, and clearing drops the pinned IP', async () => {
  const { transport } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice({ username: null, hostKey: null })
    const headers = await adminAuthHeader()
    const stale = await app.inject({
      method: 'PUT',
      url: `/devices/${deviceId}/ssh`,
      headers,
      payload: { username: 'root', port: 22, hostKeyFingerprint: TRUSTED, hostKeyIp: '10.1.2.3', password: ADMIN_PASSWORD },
    })
    assert.equal(stale.statusCode, 409)
    const row = await getDb().get('SELECT ssh_host_key, ssh_host_ip FROM devices WHERE id = ?', [deviceId])
    assert.equal(row.ssh_host_key, null)
    assert.equal(row.ssh_host_ip, null)

    const pinned = await insertDevice()
    const removed = await app.inject({ method: 'DELETE', url: `/devices/${pinned}/ssh`, headers, payload: { password: ADMIN_PASSWORD } })
    assert.equal(removed.statusCode, 200)
    const cleared = await getDb().get('SELECT ssh_host_ip FROM devices WHERE id = ?', [pinned])
    assert.equal(cleared.ssh_host_ip, null)
  } finally {
    await app.close()
  }
})

test('every SSH route rejects an authenticated non-admin user with 403', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    const headers = await userAuthHeader()
    const body = { command: 'uptime', password: ADMIN_PASSWORD }
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/ssh/public-key', headers }),
      app.inject({ method: 'POST', url: `/devices/${deviceId}/ssh/scan`, headers, payload: { port: 22 } }),
      app.inject({ method: 'PUT', url: `/devices/${deviceId}/ssh`, headers, payload: { username: 'root', port: 22, hostKeyFingerprint: TRUSTED, hostKeyIp: await deviceIp(deviceId), password: ADMIN_PASSWORD } }),
      app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers, payload: { password: ADMIN_PASSWORD } }),
      app.inject({ method: 'POST', url: `/devices/${deviceId}/commands`, headers, payload: body }),
      app.inject({ method: 'GET', url: `/devices/${deviceId}/commands`, headers }),
    ])
    assert.deepEqual(responses.map((r) => r.statusCode), [403, 403, 403, 403, 403, 403])
    assert.equal(calls.length, 0)
    assert.equal((await getDb().all('SELECT id FROM command_runs')).length, 0)
  } finally {
    await app.close()
  }
})

test('repeated wrong passwords lock the account for SSH re-confirmation, even for the right password', async () => {
  const { transport, calls } = makeTransport()
  const app = buildApp(transport)
  try {
    const deviceId = await insertDevice()
    for (let attempt = 0; attempt < ACCOUNT_LOCK_THRESHOLD; attempt += 1) {
      const wrong = await runCommandRequest(app, deviceId, { command: 'uptime', password: 'wrong' })
      assert.equal(wrong.statusCode, 403)
    }
    const locked = await runCommandRequest(app, deviceId, { command: 'uptime', password: ADMIN_PASSWORD })
    assert.equal(locked.statusCode, 429)
    assert.ok(Number(locked.headers['retry-after']) > 0)
    const del = await app.inject({ method: 'DELETE', url: `/devices/${deviceId}/ssh`, headers: await adminAuthHeader(), payload: { password: ADMIN_PASSWORD } })
    assert.equal(del.statusCode, 429)
    assert.equal(calls.length, 0)
  } finally {
    resetPasswordThrottles()
    await app.close()
  }
})
