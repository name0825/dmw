import Fastify from 'fastify'

import { AGENT_PAIR_RATE_LIMIT } from '../config/constants.js'
import { normalizeUsage } from '../utils/validation.js'

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
// ...existing code...
export const extractApiKey = (authHeader: string): string => {
  if (!authHeader.startsWith('Bearer ')) return ''
  return authHeader.slice('Bearer '.length)
}
