import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-ws-auth-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')
process.env.PORT = String(20_000 + (process.pid % 20_000))

const { initPool, closePool, getDb } = await import('./database/index.js')
const { ADMIN_EMAIL, PORT } = await import('./config.js')
const { createToken } = await import('./auth.js')
const { bumpTokenVersion } = await import('./database/auth.js')
const { setupWebSocket, closeWebSocket, broadcastState } = await import('./services/ws.js')

const connect = (token: string) => new Promise<WebSocket>((resolve, reject) => {
  const client = new WebSocket(`ws://127.0.0.1:${PORT + 1}`, token)
  client.once('open', () => resolve(client))
  client.once('error', reject)
})

const rejectConnection = (tokens: string[]) => new Promise<void>((resolve, reject) => {
  const client = new WebSocket(`ws://127.0.0.1:${PORT + 1}`, tokens)
  client.once('open', () => {
    client.close()
    reject(new Error('connection unexpectedly opened'))
  })
  client.once('error', () => resolve())
})

before(async () => {
  await initPool()
  setupWebSocket()
})

after(async () => {
  await closeWebSocket()
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('handshake authorizes the same protocol token selected for the connection', async () => {
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  const staleToken = createToken(ADMIN_EMAIL, user.token_version)
  await bumpTokenVersion(user.id)
  const currentToken = createToken(ADMIN_EMAIL, user.token_version + 1)

  await rejectConnection([staleToken, currentToken])
})

test('broadcast closes a client whose token was revoked after connection', async () => {
  const db = getDb()
  const user = await db.get('SELECT id, token_version FROM users WHERE email = ?', [ADMIN_EMAIL])
  const token = createToken(ADMIN_EMAIL, user.token_version)
  const client = await connect(token)
  let receivedMessage = false
  client.on('message', () => {
    receivedMessage = true
  })
  const closed = new Promise<number>((resolve) => client.once('close', resolve))

  await bumpTokenVersion(user.id)
  await broadcastState()

  assert.equal(await closed, 1008)
  assert.equal(receivedMessage, false)
})
