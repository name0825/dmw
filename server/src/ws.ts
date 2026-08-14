import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { JWT_SECRET } from './config.js'
import { db } from './db.js'
import { evaluateDeviceStatus } from './deviceStatus.js'

export const wsClients = new Set<any>()

export const broadcastState = async () => {
  const devices = await db.all('SELECT * FROM devices ORDER BY id DESC')
  const normalized = devices.map((device: any) => ({
    ...device,
    status: evaluateDeviceStatus(device, new Date()),
  }))
  const payload = JSON.stringify({ type: 'devices-updated', devices: normalized })

  for (const socket of wsClients) {
    if (socket.readyState === 1) {
      socket.send(payload)
    }
  }
}

const getAuthTokenFromRequest = (request: any) => {
  const header = request.headers.authorization || ''
  if (header.startsWith('Bearer ')) {
    return header.slice(7)
  }

  const url = new URL(request.url || '/', 'http://localhost')
  return url.searchParams.get('token') || ''
}

export const setupWebSocket = (server: any) => {
  const wsServer = new WebSocketServer({ server })

  wsServer.on('connection', (socket: any, request: any) => {
    const token = getAuthTokenFromRequest(request)

    if (!token) {
      socket.close(1008, 'Unauthorized')
      return
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { email?: string }
      if (!decoded || typeof decoded !== 'object' || !decoded.email) {
        throw new Error('token missing email claim')
      }
    } catch {
      socket.close(1008, 'Unauthorized')
      return
    }

    wsClients.add(socket)
    socket.send(JSON.stringify({ type: 'connected', message: 'DMW socket connected' }))
    socket.on('close', () => wsClients.delete(socket))
  })

  return wsServer
}
