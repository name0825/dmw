import Fastify from 'fastify'

import { DEVICE_WAKE_RATE_LIMIT } from '../config/constants.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers device management routes
 * @param app - Fastify app instance
 */
export const registerDeviceRoutes = (app: any) => {
  app.get('/dashboard', async () => {
    return await handleGetDashboard()
  })

  app.get('/devices', async () => {
    return await handleGetDevices()
  })

  app.get('/devices/:id/history', async (request: any) => {
    return await handleGetDeviceHistory(request)
  })

  app.get('/alerts', async () => {
    return await handleGetAlerts()
  })

  app.post('/devices', async (request: any, reply: any) => {
    return await handleCreateDevice(request, reply)
  })

  app.patch('/devices/:id', async (request: any, reply: any) => {
    return await handleUpdateDevice(request, reply)
  })

  app.delete('/devices/:id', async (request: any, reply: any) => {
    return await handleDeleteDevice(request, reply)
  })

  app.post('/devices/:id/wake', { config: { rateLimit: DEVICE_WAKE_RATE_LIMIT } }, async (request: any, reply: any) => {
    return await handleWakeDevice(request, reply)
  })
}
