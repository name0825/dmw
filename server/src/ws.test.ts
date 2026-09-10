import test, { after, afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { WebSocket } from 'ws'

const websocketPort = await new Promise<number>((resolve, reject) => {
  const listener = net.createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address()
    if (!address || typeof address === 'string') {
      listener.close()
      reject(new Error('Failed to allocate a WebSocket test port'))
      return
    }
    listener.close((error) => error ? reject(error) : resolve(address.port))
  })
})

process.env.DB_PATH = ':memory:'
process.env.PORT = String(websocketPort - 1)

const { createToken } = await import('./auth.js')
const { initPool, closePool, getDb } = await import('./database/index.js')
const { bumpTokenVersion } = await import('./database/auth.js')
const { broadcastState, closeWebSocket, setupWebSocket } = await import('./services/ws.js')

const clients = new Set<WebSocket>()

const openClient = async (protocols: string[]) => {
  const client = new WebSocket(`ws://127.0.0.1:${websocketPort}`, protocols)
  clients.add(client)
  await once(client, 'open')
  return client
}

const waitForMessage = async (client: WebSocket) => {
  const [data] = await once(client, 'message', { signal: AbortSignal.timeout(2_000) })
  return JSON.parse(data.toString())
}

beforeEach(async () => {
  const db = await initPool()
  await db.exec('DELETE FROM devices; DELETE FROM users;')
})

afterEach(async () => {
  for (const client of clients) client.terminate()
  clients.clear()
  await closeWebSocket()
})

after(async () => {
  await closeWebSocket()
  await closePool()
})

test('broadcast drops a revoked socket while an authorized socket still receives state', async () => {
  const db = getDb()
  const revokedResult = await db.run(
    'INSERT INTO users (email, password_hash, token_version) VALUES (?, ?, 0)',
    ['revoked@example.com', 'unused'],
  )
  const validResult = await db.run(
    'INSERT INTO users (email, password_hash, token_version) VALUES (?, ?, 0)',
    ['valid@example.com', 'unused'],
  )
  const revokedToken = createToken('revoked@example.com', 0)
  const validToken = createToken('valid@example.com', 0)

  setupWebSocket()
  const revokedClient = await openClient([revokedToken])
  await bumpTokenVersion(revokedResult.lastID)
  const validClient = await openClient([revokedToken, validToken])
  assert.equal(validClient.protocol, validToken)

  const revokedMessages: unknown[] = []
  revokedClient.on('message', (message) => revokedMessages.push(message))
  const revokedClosed = once(revokedClient, 'close', { signal: AbortSignal.timeout(2_000) })
  const validMessage = waitForMessage(validClient)

  await broadcastState()

  const payload = await validMessage
  await revokedClosed
  assert.equal(payload.type, 'devices-updated')
  assert.deepEqual(payload.devices, [])
  assert.deepEqual(revokedMessages, [])
  assert.equal((await db.get('SELECT token_version FROM users WHERE id = ?', [validResult.lastID])).token_version, 0)
})

test('token verification is cached per connection within the TTL and refreshed after it expires', async () => {
  const db = getDb()
  await db.run(
    'INSERT INTO users (email, password_hash, token_version) VALUES (?, ?, 0)',
    ['cached@example.com', 'unused'],
  )
  const token = createToken('cached@example.com', 0)

  setupWebSocket()
  const client = await openClient([token])

  const originalGet = db.get.bind(db)
  let verifyCallCount = 0
  db.get = (...args: unknown[]) => {
    if (String(args[0]).includes('FROM users')) verifyCallCount++
    return originalGet(...args)
  }

  mock.timers.enable({ apis: ['Date'] })

  try {
    const firstMessage = waitForMessage(client)
    await broadcastState()
    await firstMessage
    assert.equal(verifyCallCount, 1)

    const secondMessage = waitForMessage(client)
    await broadcastState()
    await secondMessage
    assert.equal(verifyCallCount, 1)

    mock.timers.tick(5_001)

    const thirdMessage = waitForMessage(client)
    await broadcastState()
    await thirdMessage
    assert.equal(verifyCallCount, 2)
  } finally {
    mock.timers.reset()
    db.get = originalGet
  }
})
