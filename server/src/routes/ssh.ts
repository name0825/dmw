import { isIP } from 'node:net'

import bcrypt from 'bcryptjs'

import { SSH_COMMAND_MAX_LENGTH, SSH_CONNECT_TIMEOUT_MS, SSH_EXEC_RATE_LIMIT_MAX, RATE_LIMIT_TIME_WINDOW } from '../config/constants.js'
import { beginSshConfirmAttempt } from '../auth.js'
import { getDb, withTransaction } from '../database/index.js'
import { FINGERPRINT_PATTERN, recordSshAudit, runCommand, ssh2Transport, SshError } from '../services/ssh.js'
import type { SshAuditEntry } from '../services/ssh.js'
import type { SshDeps } from '../services/ssh.js'
import { getPublicKey } from '../services/sshKey.js'
import { broadcastState } from '../services/ws.js'

const USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/
const MAX_PASSWORD_LENGTH = 256
const DEFAULT_SSH_PORT = 22

const rateLimit = { config: { rateLimit: { max: SSH_EXEC_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }

const requireAdmin = async (request: any, reply: any) => {
  if (request.user?.role !== 'admin') {
    return reply.code(403).send({ message: 'Forbidden' })
  }
}

const adminOnly = { preHandler: requireAdmin }
const adminRateLimited = { ...rateLimit, preHandler: requireAdmin }

const parseId = (value: unknown): number | null => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

const parsePort = (value: unknown): number | null => {
  const port = value === undefined || value === null ? DEFAULT_SSH_PORT : Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

const findDevice = (id: number) =>
  getDb().get('SELECT id, name, ip_address, ssh_username, ssh_port, ssh_host_key, ssh_host_ip FROM devices WHERE id = ?', [id])

const isValidPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PASSWORD_LENGTH

const snapshot = (device: any) => ({
  username: device.ssh_username ?? null,
  port: device.ssh_port ?? null,
  fingerprint: device.ssh_host_key ?? null,
})

const confirmPassword = async (
  request: any,
  reply: any,
  password: string,
  event: 'command_reauth_failed' | 'config_reauth_failed',
  deviceId: number,
) => {
  const attempt = beginSshConfirmAttempt(request.user.id)
  if (attempt.lockedMs > 0) {
    reply.header('Retry-After', String(Math.ceil(attempt.lockedMs / 1000)))
    reply.code(429).send({ message: 'Too many failed attempts. Try again later.' })
    return null
  }
  let user: any
  let verified = false
  try {
    user = await getDb().get('SELECT id, password_hash FROM users WHERE id = ?', [request.user.id])
    verified = Boolean(user) && (await bcrypt.compare(password, user.password_hash))
  } catch (error) {
    attempt.cancel()
    throw error
  }
  if (verified) {
    attempt.succeed()
    return user
  }
  console.warn(`SSH re-authentication failed for user ${request.user.id} (${event})`)
  try {
    await recordSshAudit({ event, userId: user?.id ?? null, deviceId } as SshAuditEntry)
  } catch (error) {
    console.error('Error recording SSH re-authentication failure:', (error as Error)?.message)
  }
  reply.code(403).send({ message: 'Password confirmation failed' })
  return null
}

const broadcastQuietly = async () => {
  try {
    await broadcastState()
  } catch (error) {
    console.error('Error broadcasting state after SSH config change:', error)
  }
}

const errorReply = (reply: any, error: SshError) => {
  const body = (message: string) => ({ message, ...(error.runId ? { runId: error.runId } : {}) })
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return reply.code(409).send(body('SSH is not configured for this device'))
    case 'HOST_KEY_MISMATCH':
      return reply.code(409).send(body('SSH host key does not match the trusted fingerprint'))
    case 'HOST_IP_CHANGED':
      return reply.code(409).send(body(error.message))
    case 'DEVICE_BUSY':
    case 'GLOBAL_BUSY':
      return reply.code(429).send(body(error.message))
    case 'TIMEOUT':
      return reply.code(504).send(body('SSH command timed out'))
    case 'KEY_UNAVAILABLE':
      return reply.code(500).send(body('Internal server error'))
    default:
      return reply.code(502).send(body('SSH connection or authentication failed'))
  }
}

/**
 * Registers SSH remote command routes.
 * @param app - Fastify app instance
 * @param deps - Injectable SSH transport (tests pass a fake)
 */
export const registerSshRoutes = (app: any, deps: SshDeps = { transport: ssh2Transport }) => {
  app.get('/ssh/public-key', adminOnly, async (_request: any, reply: any) => {
    try {
      return { publicKey: await getPublicKey() }
    } catch (error) {
      console.error('Error reading SSH public key:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })

  app.post('/devices/:id/ssh/scan', adminRateLimited, async (request: any, reply: any) => {
    const id = parseId(request.params.id)
    const port = parsePort((request.body || {}).port)
    if (!id || !port) {
      reply.code(400).send({ message: 'Invalid device id or port' })
      return
    }
    try {
      const device = await findDevice(id)
      if (!device) {
        reply.code(404).send({ message: 'Device not found' })
        return
      }
      const fingerprint = await deps.transport.scanHostKey(device.ip_address, port, SSH_CONNECT_TIMEOUT_MS)
      return { fingerprint, ip: device.ip_address }
    } catch (error) {
      if (error instanceof SshError) {
        reply.code(error.code === 'TIMEOUT' ? 504 : 502).send({ message: 'Could not read the SSH host key' })
        return
      }
      console.error('Error scanning SSH host key:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })

  app.put('/devices/:id/ssh', adminRateLimited, async (request: any, reply: any) => {
    const id = parseId(request.params.id)
    const { username, port: rawPort, hostKeyFingerprint, hostKeyIp, password } = request.body || {}
    const port = parsePort(rawPort)
    if (
      !id ||
      !port ||
      !isValidPassword(password) ||
      typeof username !== 'string' ||
      !USERNAME_PATTERN.test(username) ||
      typeof hostKeyFingerprint !== 'string' ||
      !FINGERPRINT_PATTERN.test(hostKeyFingerprint) ||
      typeof hostKeyIp !== 'string' ||
      isIP(hostKeyIp) === 0
    ) {
      reply.code(400).send({ message: 'Valid username, port, host key fingerprint, scanned IP, and password are required' })
      return
    }
    try {
      const user = await confirmPassword(request, reply, password, 'config_reauth_failed', id)
      if (!user) return
      const device = await findDevice(id)
      if (!device) {
        reply.code(404).send({ message: 'Device not found' })
        return
      }
      if (device.ip_address !== hostKeyIp) {
        reply.code(409).send({ message: 'The device IP address changed since the host key was scanned; re-scan the host key' })
        return
      }
      await withTransaction(async (db) => {
        await db.run('UPDATE devices SET ssh_username = ?, ssh_port = ?, ssh_host_key = ?, ssh_host_ip = ? WHERE id = ?', [
          username,
          port,
          hostKeyFingerprint,
          hostKeyIp,
          id,
        ])
        await recordSshAudit(
          {
            event: 'config_set',
            userId: user.id,
            deviceId: id,
            before: snapshot(device),
            after: { username, port, fingerprint: hostKeyFingerprint },
          },
          db,
        )
      })
      await broadcastQuietly()
      return { message: 'SSH settings saved' }
    } catch (error) {
      console.error('Error saving SSH settings:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })

  app.delete('/devices/:id/ssh', adminRateLimited, async (request: any, reply: any) => {
    const id = parseId(request.params.id)
    const { password } = request.body || {}
    if (!id || !isValidPassword(password)) {
      reply.code(400).send({ message: 'Valid device id and password are required' })
      return
    }
    try {
      const user = await confirmPassword(request, reply, password, 'config_reauth_failed', id)
      if (!user) return
      const device = await findDevice(id)
      if (!device) {
        reply.code(404).send({ message: 'Device not found' })
        return
      }
      await withTransaction(async (db) => {
        await db.run('UPDATE devices SET ssh_username = NULL, ssh_port = NULL, ssh_host_key = NULL, ssh_host_ip = NULL WHERE id = ?', [id])
        await recordSshAudit(
          {
            event: 'config_clear',
            userId: user.id,
            deviceId: id,
            before: snapshot(device),
            after: { username: null, port: null, fingerprint: null },
          },
          db,
        )
      })
      await broadcastQuietly()
      return { message: 'SSH settings removed' }
    } catch (error) {
      console.error('Error removing SSH settings:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })

  app.post('/devices/:id/commands', adminRateLimited, async (request: any, reply: any) => {
    const id = parseId(request.params.id)
    const { command, password } = request.body || {}
    if (
      !id ||
      typeof command !== 'string' ||
      command.trim().length === 0 ||
      command.length > SSH_COMMAND_MAX_LENGTH ||
      command.includes('\0') ||
      !isValidPassword(password)
    ) {
      reply.code(400).send({ message: 'Valid command and password are required' })
      return
    }

    try {
      const user = await confirmPassword(request, reply, password, 'command_reauth_failed', id)
      if (!user) return

      const device = await findDevice(id)
      if (!device) {
        reply.code(404).send({ message: 'Device not found' })
        return
      }

      return await runCommand(deps, device, user.id, command)
    } catch (error) {
      if (error instanceof SshError) return errorReply(reply, error)
      console.error('Error running SSH command:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })

  app.get('/devices/:id/commands', adminOnly, async (request: any, reply: any) => {
    const id = parseId(request.params.id)
    const rawLimit = request.query?.limit === undefined ? 20 : Number(request.query.limit)
    if (!id || !Number.isInteger(rawLimit) || rawLimit < 1) {
      reply.code(400).send({ message: 'Invalid device id or limit' })
      return
    }
    try {
      const runs = await getDb().all(
        `SELECT id, command, exit_code AS exitCode, signal, truncated, error, started_at AS startedAt, finished_at AS finishedAt
         FROM command_runs WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
        [id, Math.min(rawLimit, 100)],
      )
      return { runs: runs.map((run: any) => ({ ...run, truncated: Boolean(run.truncated) })) }
    } catch (error) {
      console.error('Error listing command runs:', (error as Error)?.message)
      reply.code(500).send({ message: 'Internal server error' })
    }
  })
}
