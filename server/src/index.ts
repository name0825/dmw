import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import wol from 'wake_on_lan'

import { APP_ENV, CORS_ORIGIN, PORT } from './config.js'
import { db, ensureAdmin } from './db.js'
import { authMiddleware, createToken, findRefreshTokenMatch, revokeRefreshToken } from './auth.js'
import { evaluateAlerts } from './alerts.js'
import { broadcastState, setupWebSocket } from './ws.js'
import { updateOfflineStates, monitorAlerts } from './monitoring.js'

const app = Fastify({ logger: false })
await app.register(cookie)
await app.register(cors, {
  origin: (origin, callback) => {
    const allowedOrigins = new Set([...CORS_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'])
    const isAllowed = !origin || allowedOrigins.has(origin) || !APP_ENV || APP_ENV === 'development'
    callback(null, isAllowed)
  },
  credentials: true,
})

app.addHook('preHandler', async (request: any, reply) => {
  const skipAuthRoutes = ['/auth/login', '/health', '/agent/pair', '/agent/heartbeat']
  if (!skipAuthRoutes.includes(request.url) && !request.url.startsWith('/auth/refresh')) {
    await authMiddleware(request, reply)
  }
})

await ensureAdmin()

app.get('/health', async () => ({ status: 'ok' }))

app.post('/auth/login', async (request, reply) => {
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

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    reply.code(401).send({ message: 'Invalid credentials' })
    return
  }

  const accessToken = createToken(user.email)
  const refreshToken = randomBytes(32).toString('hex')
  const refreshHash = await bcrypt.hash(refreshToken, 10)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()

  await db.run(
    'INSERT INTO refresh_tokens (token_hash, issued_at, expires_at, revoked) VALUES (?, ?, ?, 0)',
    [refreshHash, new Date().toISOString(), expiresAt],
  )

  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false,
    maxAge: 60 * 60 * 24 * 7,
  })

  return { accessToken, refreshToken }
})

app.post('/auth/refresh', async (request, reply) => {
  const cookieToken = request.cookies?.refreshToken || ''
  const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken || ''
  const refreshToken = bodyToken || cookieToken

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

  const accessToken = createToken('admin@dmw.local')
  return { accessToken }
})

app.post('/auth/logout', async (request, reply) => {
  const cookieToken = request.cookies?.refreshToken || ''
  const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken || ''
  const refreshToken = bodyToken || cookieToken

  if (refreshToken) {
    await revokeRefreshToken(refreshToken)
  }

  reply.clearCookie('refreshToken')
  return { message: 'Logged out' }
})

app.get('/dashboard', async () => {
  const devices = await db.all('SELECT * FROM devices ORDER BY id DESC')
  return {
    total: devices.length,
    online: devices.filter((device) => device.status === 'ONLINE').length,
    offline: devices.filter((device) => device.status === 'OFFLINE').length,
    notPaired: devices.filter((device) => device.agent_paired === 0).length,
  }
})

app.get('/devices', async () => {
  const devices = await db.all(`
    SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage, m.updated_at AS metrics_updated_at
    FROM devices d
    LEFT JOIN device_metrics_latest m ON m.device_id = d.id
    ORDER BY d.id DESC
  `)
  return { devices }
})

app.get('/devices/:id/history', async (request: any) => {
  const { id } = request.params
  const history = await db.all(
    'SELECT * FROM device_metrics_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 10',
    [id],
  )

  return { history }
})

app.get('/alerts', async () => {
  const devices = await db.all(`
    SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage
    FROM devices d
    LEFT JOIN device_metrics_latest m ON m.device_id = d.id
    ORDER BY d.id DESC
  `)

  return { alerts: devices.flatMap((device: any) => evaluateAlerts(device)) }
})

app.post('/devices', async (request: any, reply) => {
  const { name, mac_address, ip_address } = (request.body || {}) as {
    name?: string
    mac_address?: string
    ip_address?: string
  }

  if (!name || !mac_address || !ip_address) {
    reply.code(400).send({ message: 'Missing required fields' })
    return
  }

  const result = await db.run(
    'INSERT INTO devices (name, mac_address, ip_address, status, agent_paired, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    [name, mac_address, ip_address, 'NOT_PAIRED', new Date().toISOString(), new Date().toISOString()],
  )

  const deviceId = Number((result as any).lastID)
  const code = randomBytes(4).toString('hex').toUpperCase()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await db.run(
    'INSERT INTO pairing_codes (device_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [deviceId, code, expiresAt, new Date().toISOString()],
  )

  await broadcastState()
  return { deviceId, pairingCode: code, expiresAt }
})

app.patch('/devices/:id', async (request: any) => {
  const { id } = request.params
  const { name, mac_address, ip_address } = (request.body || {}) as {
    name?: string
    mac_address?: string
    ip_address?: string
  }

  const fields: string[] = []
  const values: any[] = []

  if (name) {
    fields.push('name = ?')
    values.push(name)
  }
  if (mac_address) {
    fields.push('mac_address = ?')
    values.push(mac_address)
  }
  if (ip_address) {
    fields.push('ip_address = ?')
    values.push(ip_address)
  }

  if (!fields.length) {
    return { message: 'No changes provided' }
  }

  values.push(new Date().toISOString(), id)
  await db.run(`UPDATE devices SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, values)
  await broadcastState()
  return { message: 'Device updated' }
})

app.delete('/devices/:id', async (request: any) => {
  const { id } = request.params
  await db.run('DELETE FROM devices WHERE id = ?', [id])
  await db.run('DELETE FROM pairing_codes WHERE device_id = ?', [id])
  await db.run('DELETE FROM device_metrics_latest WHERE device_id = ?', [id])
  await broadcastState()
  return { message: 'Device deleted' }
})

app.post('/devices/:id/wake', async (request: any, reply) => {
  const { id } = request.params
  const device = await db.get('SELECT * FROM devices WHERE id = ?', [id])

  if (!device) {
    reply.code(404).send({ message: 'Device not found' })
    return
  }

  if (!device.agent_paired) {
    reply.code(400).send({ message: 'Device is not paired yet' })
    return
  }

  if (device.status === 'ONLINE') {
    return { message: 'Device is already online' }
  }

  try {
    const address = device.ip_address
    const broadcast = address.split('.').slice(0, 3).join('.') + '.255'
    await new Promise<void>((resolve, reject) => {
      wol.wake(device.mac_address, { address: broadcast, port: 9 }, (error?: Error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    await db.run('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?', ['WAKE_TIMEOUT', new Date().toISOString(), id])
    await broadcastState()
    return { message: 'Wake packet sent' }
  } catch (error) {
    reply.code(500).send({ message: 'Failed to send WOL packet', error: String(error) })
  }
})

app.post('/agent/pair', async (request: any, reply) => {
  const { ip, pairingCode } = (request.body || {}) as { ip?: string; pairingCode?: string }
  if (!ip || !pairingCode) {
    reply.code(400).send({ message: 'IP and pairing code required' })
    return
  }

  const activeCode = await db.get(
    'SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    [pairingCode, new Date().toISOString()],
  )

  if (!activeCode) {
    reply.code(400).send({ message: 'Pairing code invalid or expired' })
    return
  }

  const device = await db.get('SELECT * FROM devices WHERE id = ?', [activeCode.device_id])
  if (!device) {
    reply.code(404).send({ message: 'Device not found' })
    return
  }

  const apiKey = randomBytes(24).toString('hex')
  const apiKeyHash = await bcrypt.hash(apiKey, 10)
  const apiKeyHint = apiKey.slice(0, 12)
  await db.run(
    'UPDATE devices SET agent_key_hash = ?, agent_key_hint = ?, agent_paired = 1, paired_at = ?, last_seen = ?, status = ?, updated_at = ? WHERE id = ?',
    [apiKeyHash, apiKeyHint, new Date().toISOString(), new Date().toISOString(), 'ONLINE', new Date().toISOString(), device.id],
  )
  await db.run('UPDATE pairing_codes SET used_at = ? WHERE id = ?', [new Date().toISOString(), activeCode.id])
  await broadcastState()

  return { apiKey, deviceId: device.id }
})

app.post('/agent/heartbeat', async (request: any, reply) => {
  const authHeader = request.headers.authorization || ''
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!apiKey) {
    reply.code(401).send({ message: 'Missing API key' })
    return
  }

  const apiKeyHint = apiKey.slice(0, 12)
  const matchedDevice = await db.get('SELECT * FROM devices WHERE agent_paired = 1 AND agent_key_hint = ?', [apiKeyHint])
  if (!matchedDevice) {
    reply.code(401).send({ message: 'Invalid API key' })
    return
  }

  const ok = await bcrypt.compare(apiKey, matchedDevice.agent_key_hash)
  if (!ok) {
    reply.code(401).send({ message: 'Invalid API key' })
    return
  }

  const { cpuUsage, memoryUsage, diskUsage } = (request.body || {}) as {
    cpuUsage?: number
    memoryUsage?: number
    diskUsage?: number
  }

  const now = new Date().toISOString()
  await db.run(
    'UPDATE devices SET last_seen = ?, status = ?, updated_at = ? WHERE id = ?',
    [now, 'ONLINE', now, matchedDevice.id],
  )
  await db.run(
    'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET cpu_usage = excluded.cpu_usage, memory_usage = excluded.memory_usage, disk_usage = excluded.disk_usage, updated_at = excluded.updated_at',
    [matchedDevice.id, cpuUsage ?? 0, memoryUsage ?? 0, diskUsage ?? 0, now],
  )
  await db.run(
    'INSERT INTO device_metrics_history (device_id, timestamp, cpu_usage, memory_usage, disk_usage) VALUES (?, ?, ?, ?, ?)',
    [matchedDevice.id, now, cpuUsage ?? 0, memoryUsage ?? 0, diskUsage ?? 0],
  )
  await broadcastState()

  return { message: 'Heartbeat received' }
})

setInterval(() => {
  updateOfflineStates().catch(() => undefined)
  monitorAlerts().catch(() => undefined)
}, 10000)

await app.listen({ port: PORT, host: '0.0.0.0' })
setupWebSocket(app.server)
console.log(`DMW server listening on http://localhost:${PORT}`)
