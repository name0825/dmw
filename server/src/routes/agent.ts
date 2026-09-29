import {
  AGENT_PAIR_RATE_LIMIT_MAX,
  AGENT_HEARTBEAT_RATE_LIMIT_MAX,
  AGENT_UNPAIR_RATE_LIMIT_MAX,
  RATE_LIMIT_TIME_WINDOW,
} from '../config/constants.js'
import * as agentService from '../services/agent.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers agent (device-side) routes
 * @param app - Fastify app instance
 */
export const registerAgentRoutes = (app: any) => {
  app.post('/agent/pair', { config: { rateLimit: { max: AGENT_PAIR_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await agentService.handlePair(request, reply)
  })

  app.post('/agent/heartbeat', { config: { rateLimit: { max: AGENT_HEARTBEAT_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await agentService.handleHeartbeat(request, reply)
  })

  app.post('/agent/unpair', { config: { rateLimit: { max: AGENT_UNPAIR_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await agentService.handleUnpair(request, reply)
  })
}
