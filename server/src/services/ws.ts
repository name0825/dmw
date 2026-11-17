import { WebSocketServer, WebSocket } from 'ws'
import { BIND_HOST, WS_PORT } from '../config.js'
import { getDb } from '../database/index.js'
import { isValidJwtToken, verifyTokenAndVersion } from '../auth.js'
import { serializeDeviceRow } from '../metricSelection.js'

/**
 * WebSocket service module
 * Provides WebSocket helper functions for broadcasting state updates
 */

let wss: WebSocketServer | undefined;

type WebSocketClient = {
  protocol: string
  readyState: number
  send: (payload: string) => void
  close: (code: number, reason: string) => void
}

export const selectWebSocketProtocol = (
  protocols: Iterable<string>,
  validate: (token: string) => boolean = isValidJwtToken,
): string | false => [...protocols].find((protocol) => validate(protocol)) || false

export const authorizeWebSocketProtocols = async (
  protocols: Iterable<string>,
  verify: typeof verifyTokenAndVersion = verifyTokenAndVersion,
  validate: (token: string) => boolean = isValidJwtToken,
): Promise<boolean> => {
  const selectedToken = selectWebSocketProtocol(protocols, validate)
  return selectedToken !== false && await verify(selectedToken) !== null
}

export const sendStateToClient = async (
  client: WebSocketClient,
  payload: string,
  verify: typeof verifyTokenAndVersion = verifyTokenAndVersion,
): Promise<void> => {
  if (client.readyState !== WebSocket.OPEN) return

  const user = await verify(client.protocol)
  if (!user) {
    client.close(1008, 'Unauthorized')
    return
  }

  if (client.readyState === WebSocket.OPEN) client.send(payload)
}

/**
 * Broadcasts the current device list to all connected WebSocket clients
 * Uses async/await pattern for proper error and stack trace handling
 */
export const broadcastState = async () => {
  const db = getDb()
  const rows = await db.all(
    // agent_key_hash / agent_key_hint 는 브라우저로 나가면 안 되므로 컬럼을 명시한다.
    `SELECT d.id, d.name, d.mac_address, d.ip_address, d.agent_paired, d.paired_at,
            d.last_seen, d.status, d.agent_version, d.created_at, d.updated_at,
            d.ssh_username, d.ssh_port, d.ssh_host_key,
            d.metric_selection,
            d.update_state, d.update_message, d.update_state_at,
            m.cpu_usage, m.memory_usage, m.disk_usage,
            m.cpu_temp, m.memory_temp, m.cpu_clock, m.memory_clock, m.disks_json
     FROM devices d LEFT JOIN device_metrics_latest m ON m.device_id = d.id ORDER BY d.id DESC`,
  )
  const devices = rows.map(serializeDeviceRow)

  if (wss && wss.clients.size > 0) {
    const payload = JSON.stringify({ type: 'devices-updated', devices })
    await Promise.all([...wss.clients].map((client) => sendStateToClient(client, payload)))
  }

  return { message: 'State broadcast initiated', deviceCount: devices.length }
}

/**
 * Starts the WebSocket server on WS_PORT.
 * 이 서버는 Fastify 와 포트를 공유하지 않는 독립 리스너이므로 app 인스턴스가 필요 없다.
 */
export const setupWebSocket = () => {
  // Initialize WebSocket server
  const server = new WebSocketServer({
    port: WS_PORT,
    host: BIND_HOST,
    // 실제 인가 판정(서명 + token_version)은 여기서 내린다. handleProtocols 는
    // 동기 함수라 DB 조회가 불가능하므로 서명 검증만 하는 사전 필터일 뿐이며,
    // handleProtocols 를 통과했더라도 여기서 거절되면 연결은 성립하지 않는다.
    verifyClient: (info, callback) => {
      const protocolHeader = info.req.headers['sec-websocket-protocol'] || ''
      const tokens = protocolHeader.split(',').map((value) => value.trim()).filter(Boolean)

      authorizeWebSocketProtocols(tokens)
        .then((isAuthorized) => {
          if (!isAuthorized) {
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
      return selectWebSocketProtocol(protocols)
    },
  });
  wss = server;

  server.on('error', (err: Error) => console.error('[WebSocket] Server error:', err))

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
