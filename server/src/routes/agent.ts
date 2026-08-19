import Fastify from 'fastify'

import { AGENT_PAIR_RATE_LIMIT_MAX } from '../config/constants.js'
import * as agentService from '../services/agent.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers agent (device-side) routes
 * @param app - Fastify app instance
 */
export const registerAgentRoutes = (app: any) => {
  app.post('/agent/pair', { config: { rateLimit: { max: AGENT_PAIR_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (request: any, reply: any) => {
    return await agentService.handlePair(request, reply)
  })

  app.post('/agent/heartbeat', async (request: any, reply: any) => {
    return await agentService.handleHeartbeat(request, reply)
  })
}
