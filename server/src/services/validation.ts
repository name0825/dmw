/**
 * Device validation helper functions
 * Provides reusable validation utilities for device-related requests
 */

import { isValidIp, isValidMac, normalizeIp, normalizeMac } from '../utils/validation.js'

export { isValidIp, normalizeIp }

// Pairing code validity period (10 minutes)
export const PAIRING_TTL_MS = 10 * 60 * 1000

// Rate limit for wake requests (10 per minute)
export const DEVICE_WAKE_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }

/**
 * Status constants for device states
 */
export const STATUS_NOT_PAIRED = 'NOT_PAIRED'
export const STATUS_ONLINE = 'ONLINE'
export const STATUS_WAKE_TIMEOUT = 'WAKE_TIMEOUT'

/**
 * Validates and normalizes a device registration/update request body
 * @param body - Request body
 * @param requireAll - If true, all fields are required (registration). If false, fields are optional (update)
 * @returns Object with error message (if validation failed) and normalized fields
 */
export const validateDeviceBody = (body: any, requireAll: boolean) => {
  const { name, mac_address, ip_address } = (body || {}) as {
    name?: string
    mac_address?: string
    ip_address?: string
  }

  if (requireAll && (!name || !mac_address || !ip_address)) {
    return { error: 'Missing required fields' }
  }

  if (mac_address && !isValidMac(mac_address)) {
    return { error: 'Invalid MAC address. Expected format AA:BB:CC:DD:EE:FF' }
  }

  if (ip_address && !isValidIp(ip_address)) {
    return { error: 'Invalid IP address. Expected IPv4 format (e.g. 192.168.0.20)' }
  }

  const fields: Record<string, string> = {}
  if (name) fields.name = name
  if (mac_address) fields.mac_address = normalizeMac(mac_address) as string
  if (ip_address) fields.ip_address = normalizeIp(ip_address) as string

  return { fields }
}

/**
 * Validates a usage value is a number between 0 and 100
 * @param value - The value to validate
 * @returns The validated number, or null if invalid
 */
export const normalizeUsage = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

/**
 * Creates a new pairing code and stores it in the database
 * @param deviceId - Device ID to pair
 * @param nowIso - Current time as ISO string
 * @returns Object with pairing code and expiration time
 */
export const createPairingCode = async (deviceId: number, nowIso: string) => {
  const pairingCode = randomBytes(4).toString('hex').toUpperCase()
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()

  await getDb().run(
    'INSERT INTO pairing_codes (device_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [deviceId, pairingCode, expiresAt, nowIso],
  )

  return { pairingCode, expiresAt }
}
