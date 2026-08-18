import Fastify from 'fastify'

import { AGENT_PAIR_RATE_LIMIT } from '../config/constants.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers agent (device-side) routes
 * @param app - Fastify app instance
 */
export const registerAgentRoutes = (app: any) => {
  app.post('/agent/pair', { config: { rateLimit: AGENT_PAIR_RATE_LIMIT } }, async (request: any, reply: any) => {
    return await handlePair(request, reply)
  })

  app.post('/agent/heartbeat', async (request: any, reply: any) => {
    return await handleHeartbeat(request, reply)
  })
}

/**
 * Extracts API key from Bearer authorization header
 * @param authHeader - Authorization header value
 * @returns API key string
 */
export const extractApiKey = (authHeader: string): string => {
  if (!authHeader.startsWith('Bearer ')) return ''
  return authHeader.slice('Bearer '.length)
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
