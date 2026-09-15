import { WebSocketServer, WebSocket } from 'ws'
import { PORT } from '../config.js'
import { getDb } from '../database/index.js'
import { isValidJwtToken, verifyTokenAndVersion } from '../auth.js'

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
  const db = getDb()
  const devices = await db.all(
    // agent_key_hash / agent_key_hint 는 브라우저로 나가면 안 되므로 컬럼을 명시한다.
    `SELECT d.id, d.name, d.mac_address, d.ip_address, d.agent_paired, d.paired_at,
            d.last_seen, d.status, d.created_at, d.updated_at,
            m.cpu_usage, m.memory_usage, m.disk_usage
     FROM devices d LEFT JOIN device_metrics_latest m ON m.device_id = d.id ORDER BY d.id DESC`,
  )

  if (wss && wss.clients.size > 0) {
    const payload = JSON.stringify({ type: 'devices-updated', devices })
    await Promise.all([...wss.clients].map(async (client) => {
      if (client.readyState !== WebSocket.OPEN) return

      const user = await verifyTokenAndVersion(client.protocol)
      if (!user) {
        client.close(1008, 'Unauthorized')
        return
      }

      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }))
  }

  return { message: 'State broadcast initiated', deviceCount: devices.length }
}

/**
 * Starts the WebSocket server on PORT + 1.
 * 이 서버는 Fastify 와 포트를 공유하지 않는 독립 리스너이므로 app 인스턴스가 필요 없다.
 */
export const setupWebSocket = () => {
  // Initialize WebSocket server
  const server = new WebSocketServer({
    port: PORT + 1,
    // 실제 인가 판정(서명 + token_version)은 여기서 내린다. handleProtocols 는
    // 동기 함수라 DB 조회가 불가능하므로 서명 검증만 하는 사전 필터일 뿐이며,
    // handleProtocols 를 통과했더라도 여기서 거절되면 연결은 성립하지 않는다.
    verifyClient: (info, callback) => {
      const protocolHeader = info.req.headers['sec-websocket-protocol'] || ''
      const tokens = protocolHeader.split(',').map((value) => value.trim()).filter(Boolean)
      const selectedToken = tokens.find((token) => isValidJwtToken(token))

      if (!selectedToken) {
        callback(false, 401, 'Unauthorized')
        return
      }

      verifyTokenAndVersion(selectedToken)
        .then((user) => {
          if (!user) {
            callback(false, 401, 'Unauthorized')
            return
          }
          callback(true)
        })
        .catch(() => callback(false, 401, 'Unauthorized'))
    },
    // 서명·만료만 검증해 프로토콜 문자열을 고른다 (동기 함수라 token_version
    // 조회 불가). 실질적인 인가 판정은 위 verifyClient 가 책임진다.
    handleProtocols: (protocols) => {
      const validProtocol = [...protocols].find((protocol) => isValidJwtToken(protocol))
      return validProtocol || false
    },
  });
  wss = server;

  server.on('connection', (ws: any) => {
    console.log('[WebSocket] Client connected')
    ws.on('error', (err: Error) => console.error('[WebSocket] Error:', err))
  })
}

/**
 * Terminates open client connections and closes the WebSocket server listener.
 * Safe to call multiple times or before setupWebSocket() has run.
 */
export const closeWebSocket = (): Promise<void> => {
  if (!wss) return Promise.resolve()

  const server = wss
  wss = undefined

  server.clients.forEach((client) => client.terminate())

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
