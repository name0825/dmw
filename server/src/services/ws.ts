import { WebSocketServer, WebSocket } from 'ws'
import { PORT } from '../config.js'
import { getDb } from '../database/index.js'

/**
 * WebSocket service module
 * Provides WebSocket helper functions for broadcasting state updates
 */

let wss: WebSocketServer | undefined;

/**
 * Broadcasts the current device list to all connected WebSocket clients
 * Uses async/await pattern for proper error and stack trace handling
 */
export const broadcastState = async () => {
  const db = await getDb()
  const devices = await db.all('SELECT * FROM devices')
  
  if (wss && wss.clients.size > 0) {
    const payload = JSON.stringify({ type: 'devices', data: devices })
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) { // 1 is OPEN
        client.send(payload)
      }
    })
  }
  
  return { message: 'State broadcast initiated', deviceCount: devices.length }
}

/**
 * Sets up the WebSocket server with the Fastify app
 * @param fastify - Fastify app instance
 */
export const setupWebSocket = (fastify: any) => {
  // Initialize WebSocket server
  const server = new WebSocketServer({ port: PORT + 1 });
  wss = server;
  (globalThis as any).wss = server;;

  server.on('connection', (ws: any) => {
    console.log('[WebSocket] Client connected')
    ws.on('error', (err: Error) => console.error('[WebSocket] Error:', err))
  })

  fastify.decorate('wss', server)
}
