/**
 * WebSocket service module
 * Provides WebSocket helper functions for broadcasting state updates
 */

/**
 * Broadcasts the current device list to all connected WebSocket clients
 * Uses async/await pattern for proper error handling and stack traces
 */
export const broadcastState = async () => {
  const db = await getDb()
  const devices = await db.all('SELECT * FROM devices')
  const wss = (globalThis as any).wss
  wss?.clients?.forEach((client: any) => {
    client.send(JSON.stringify({ type: 'devices', data: devices }))
  })
  return { message: 'State broadcast initiated', deviceCount: devices.length }
}
