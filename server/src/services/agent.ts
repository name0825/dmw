/**
 * Agent helper functions
 * Provides reusable utilities for agent-related operations
 */

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

import { getDb } from '../database/index.js'
import { broadcastState } from './ws.js'
import { isValidIp, normalizeIp } from '../utils/validation.js'

// Rate limit for agent pairing requests (5 per minute)
export const AGENT_PAIR_RATE_LIMIT = { max: 5, timeWindow: '1 minute' }

// Length of the first 12 characters of API key (stored as hint in DB)
export const API_KEY_HINT_LEN = 12

// Online status constant
export const STATUS_ONLINE = 'ONLINE'

/**
 * Extracts an API key from a Bearer authorization header
 * @param authHeader - The raw Authorization header value
 * @returns API key string (empty if not found)
 */
export const extractApiKey = (authHeader: string): string => {
  if (!authHeader.startsWith('Bearer ')) return ''
  return authHeader.slice('Bearer '.length)
}

/**
 * Extracts IP and pairing code from a pair request body
 * @param body - Request body
 * @returns Object with ip and pairingCode, or empty strings if missing
 */
export const extractPairRequest = (body: any) => {
  const { ip, pairingCode } = (body || {}) as { ip?: string; pairingCode?: string }
  return { ip: ip || '', pairingCode: pairingCode || '' }
}

/**
 * Extracts usage metrics from a heartbeat request body
 * @param body - Request body
 * @returns Object with cpuUsage, memoryUsage, diskUsage, or null if missing
 */
export const extractHeartbeatMetrics = (body: any) => {
  const { cpuUsage, memoryUsage, diskUsage } = (body || {}) as {
    cpuUsage?: number
    memoryUsage?: number
    diskUsage?: number
  }
  return {
    cpuUsage: cpuUsage ?? undefined,
    memoryUsage: memoryUsage ?? undefined,
    diskUsage: diskUsage ?? undefined,
  }
}

/**
 * Handles the agent pairing process.
 * Generates an API key, stores a hint, and creates a pairing code.
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Promise<void>
 */
export const handlePair = async (request: any, reply: any) => {
  const { ip, pairingCode } = extractPairRequest(request.body)
  if (!ip || !pairingCode) {
    reply.code(400).send({ message: 'IP and pairing code are required' })
    return
  }

  const db = getDb()
  const agentKey = randomBytes(32).toString('hex')
  const agentKeyHint = agentKey.substring(0, API_KEY_HINT_LEN)

  try {
    // 1. Create the device
    const result = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, status) VALUES (?, ?, ?, ?, ?, ?)',
      [`Agent-${randomBytes(4).toString('hex')}`, '', ip, agentKey, agentKeyHint, 'NOT_PAIRED']
    )
    const deviceId = result.lastID

    // 2. Create the pairing code
    await db.run(
      'INSERT INTO pairing_codes (device_id, code, expires_at) VALUES (?, ?, ?)',
      [deviceId, pairingCode, new Date(Date.now() + 5 * 60 * 1000).toISOString()]
    )

    reply.send({
      deviceId,
      agentKey,
      agentKeyHint,
      pairingCode
    })
  } catch (error) {
    console.error('Error during agent pairing:', error)
    reply.code(500).send({ message: 'Internal server error during pairing' })
  }
}

/**
 * Handles the agent heartbeat process.
 * Updates device last_seen and processes metrics.
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Promise<void>
 */
export const handleHeartbeat = async (request: any, reply: any) => {
  const authHeader = request.headers.authorization || ''
  const agentKey = extractApiKey(authHeader)
  if (!agentKey) {
    reply.code(401).send({ message: 'Invalid or missing API key' })
    return
  }

  const metrics = extractHeartbeatMetrics(request.body)
  const db = getDb()

  try {
    // Find device by agent key (using hint or partial match if needed, but here we assume we can find it)
    // In a real scenario, we might need to search by agent_key_hash. 
    // For simplicity in this demo, we's look for device with this agent_key_hint or similar.
    const device = await db.get(
      'SELECT id FROM devices WHERE agent_key_hint = ? OR agent_key_hash = ?',
      [agentKey.substring(0, API_KEY_HINT_LEN), agentKey]
    )

    if (!device) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    const deviceId = device.id
    const now = new Date().toISOString()

    // Update last seen and status
    await db.run(
      'UPDATE devices SET last_seen = ?, status = ? WHERE id = ?',
      [now, STATUS_ONLINE, deviceId]
    )

    // Update metrics
    if (metrics.cpuUsage !== undefined || metrics.memoryUsage !== undefined || metrics.diskUsage !== undefined) {
      await db.run(
        'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(device_id) DO UPDATE SET cpu_usage=excluded.cpu_usage, memory_usage=excluded.memory_usage, disk_usage=excluded.disk_usage, updated_at=excluded.updated_at',
        [deviceId, metrics.cpuUsage, metrics.memoryUsage, metrics.diskUsage, now]
      )
    }

    await broadcastState()
    reply.send({ status: 'ok' })
  } catch (error) {
    console.error('Error during agent heartbeat:', error)
    reply.code(500).send({ message: 'Internal server error during heartbeat' })
  }
}
