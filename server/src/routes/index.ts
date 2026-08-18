import Fastify from 'fastify'

// ============================================================================
// Route orchestration (defines Fastify endpoint routing)
// ============================================================================

/**
 * Registers all domain routes
 * @param app - Fastify app instance
 */
export const registerRoutes = (app: any) => {
  app.register(import('./auth.js'))
  app.register(import('./devices.js'))
  app.register(import('./agent.js'))
}
