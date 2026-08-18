import { WebSocketServer } from 'ws'
import { PORT } from './config.js'
import { getDb } from './database/index.js'

// ============================================================================
// WebSocket server setup
// ============================================================================

export const wss = new WebSocketServer({ port: PORT + 1 })

wss.on('connection', () => {
  // Add connection logic here if needed
})

// ============================================================================
// WebSocket helper functions (extracted for testability and reusability)
// ============================================================================

/**
 * Broadcasts the current device list to all connected WebSocket clients
 */
export const broadcastState = async () => {
  const db = await getDb()
  const devices = await db.all('SELECT * FROM devices')
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: 'devices', data: devices }))
  })
}

// ============================================================================
// Application setup
// ============================================================================

/**
 * Sets up the WebSocket server with the Fastify app
 * @param fastify - Fastify app instance
 */
export const setupWebSocket = (fastify: any) => {
  fastify.decorate('wss', wss)
}

import { getDb } from './database/index.js'
