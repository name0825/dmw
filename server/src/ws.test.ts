import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

import {
  authorizeWebSocketProtocols,
  selectWebSocketProtocol,
  sendStateToClient,
} from './services/ws.js'

const user = { id: 1, email: 'admin@example.com', token_version: 2 }

test('handshake authorizes the same token selected as the websocket protocol', async () => {
  const protocols = ['revoked-token', 'current-token']
  const validate = () => true
  const verify = async (token: string) => token === 'current-token' ? user : null

  assert.equal(selectWebSocketProtocol(protocols, validate), 'revoked-token')
  assert.equal(await authorizeWebSocketProtocols(protocols, verify, validate), false)
})

test('broadcast closes a revoked websocket instead of sending state', async () => {
  const events: Array<string | number> = []
  const client = {
    protocol: 'revoked-token',
    readyState: WebSocket.OPEN,
    send: (payload: string) => events.push(payload),
    close: (code: number, reason: string) => events.push(code, reason),
  }

  await sendStateToClient(client, '{"type":"devices-updated"}', async () => null)

  assert.deepEqual(events, [1008, 'Unauthorized'])
})
