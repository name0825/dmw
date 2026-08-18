/**
 * Agent helper functions
 * Provides reusable utilities for agent-related operations
 */

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

import { getDb } from '../database/index.js'
import { broadcastState } from './ws.js'
import { isValidIp, normalizeIp } from './validation.js'

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
