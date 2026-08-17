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

/**
 * 핸드셰이크 헤더에서 인증 토큰을 추출한다.
 * 토큰은 Sec-WebSocket-Protocol 서브프로토콜로 전달되므로 URL 쿼리/
 * 히스토리/프록시 로그에 노출되지 않는다. 서브프로토콜 헤더는
 * 쉼표로 구분된 여러 값을 포함할 수 있어 첫 항목으로 취한다.
 * @param {any} request - 핸드셰이크 요청
 * @returns {string} 인증 토큰 (없으면 빈 문자열)
 */
const getAuthTokenFromRequest = (request: any) => {
  const protocolHeader =
    request.headers['sec-websocket-protocol'] ||
    request.headers['Sec-WebSocket-Protocol'] ||
    ''

  const firstProtocol = String(protocolHeader).split(',')[0]?.trim() || ''
  if (!firstProtocol) return ''

  // JWT는 세그먼트 3개(점 2개)의 base64url 문자열이므로, 서브프로토콜
  // 값이 토큰인지(보통 protocol name은 점 포함 불가) 간단히 판별한다.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(firstProtocol)) {
    return ''
  }

  return firstProtocol
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
