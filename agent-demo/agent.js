require('dotenv').config()

const os = require('node:os')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001'
const PAIRING_CODE = process.env.PAIRING_CODE
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getLocalIp = () => {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address
      }
    }
  }
  return '127.0.0.1'
}

const requestJson = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  const text = await res.text()
  const data = text ? JSON.parse(text) : {}

  if (!res.ok) {
    const message = data.message || 'Request failed'
    throw new Error(`${res.status}: ${message}`)
  }

  return data
}

const pairWithServer = async () => {
  if (!PAIRING_CODE) {
    throw new Error('PAIRING_CODE 환경 변수가 필요합니다.')
  }

  const payload = {
    ip: getLocalIp(),
    pairingCode: PAIRING_CODE,
  }

  const data = await requestJson(`${SERVER_URL}/agent/pair`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  console.log('Agent paired successfully')
  console.log(`deviceId: ${data.deviceId}`)
  console.log(`apiKey: ${data.apiKey}`)
  return data.apiKey
}

const sendHeartbeat = async (apiKey, deviceId) => {
  const payload = {
    deviceId,
    cpuUsage: Number((Math.random() * 100).toFixed(1)),
    memoryUsage: Number((Math.random() * 100).toFixed(1)),
    diskUsage: Number((Math.random() * 100).toFixed(1)),
  }

  const response = await requestJson(`${SERVER_URL}/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  console.log('heartbeat sent:', response.message || 'ok')
}

// Exponential backoff with a cap, so a temporarily unreachable server does not
// cause a tight retry loop. Returns the value produced by `fn` once it succeeds.
const MAX_RETRY_DELAY_MS = Number(process.env.MAX_RETRY_DELAY_MS || 60000)

const retryWithBackoff = async (fn, label, { maxAttempts = Infinity } = {}) => {
  let attempt = 0
  let delay = 1000

  for (;;) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error
      }
      console.warn(`[${label}] attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`)
      await sleep(delay)
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
    }
  }
}

const main = async () => {
  console.log(`Connecting to ${SERVER_URL}`)

  // Pairing is a hard prerequisite: retry with backoff until the server is
  // reachable and the code is accepted.
  const apiKey = await retryWithBackoff(pairWithServer, 'pair')
  const deviceId = Number(process.env.DEVICE_ID || '1')

  // Heartbeat loop: a single failed send must not crash the agent. Log and
  // keep trying on the next tick; the server marks the device OFFLINE after
  // the configured grace period.
  while (true) {
    try {
      await sendHeartbeat(apiKey, deviceId)
    } catch (error) {
      console.warn(`[heartbeat] send failed: ${error.message}. Will retry next tick.`)
    }
    await sleep(HEARTBEAT_INTERVAL_MS)
  }
}

main().catch((error) => {
  console.error('Agent error:', error.message)
  process.exit(1)
})
