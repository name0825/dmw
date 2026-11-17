import { DEVICE_WAKE_RATE_LIMIT_MAX, RATE_LIMIT_TIME_WINDOW } from '../config/constants.js'
import { getLatestAgentRelease } from '../services/agentRelease.js'
import * as deviceService from '../services/devices.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers device management routes
 * @param app - Fastify app instance
 */
export const registerDeviceRoutes = (app: any) => {
  app.get('/dashboard', async (request: any, reply: any) => {
    return await deviceService.handleGetDashboard(request, reply)
  })

  app.get('/devices', async (request: any, reply: any) => {
    return await deviceService.handleGetDevices(request, reply)
  })

  app.get('/devices/:id/history', async (request: any, reply: any) => {
    return await deviceService.handleGetDeviceHistory(request, reply)
  })

  app.get('/alerts', async (request: any, reply: any) => {
    return await deviceService.handleGetAlerts(request, reply)
  })

  app.post('/devices', async (request: any, reply: any) => {
    return await deviceService.handleCreateDevice(request, reply)
  })

  app.patch('/devices/:id', async (request: any, reply: any) => {
    return await deviceService.handleUpdateDevice(request, reply)
  })

  app.put('/devices/:id/metric-selection', async (request: any, reply: any) => {
    return await deviceService.handleUpdateMetricSelection(request, reply)
  })

  app.delete('/devices/:id',async (request: any, reply: any) => {
    return await deviceService.handleDeleteDevice(request, reply)
  })

  app.get('/agent-release/latest', async (request: any) => {
    return await getLatestAgentRelease({ force: request.query?.refresh === '1' })
  })

  app.post('/devices/:id/agent-update', { config: { rateLimit: { max: DEVICE_WAKE_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await deviceService.handleRequestAgentUpdate(request, reply)
  })

  app.post('/devices/:id/wake', { config: { rateLimit: { max: DEVICE_WAKE_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await deviceService.handleWakeDevice(request, reply)
  })
}