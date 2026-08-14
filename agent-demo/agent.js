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

const main = async () => {
  console.log(`Connecting to ${SERVER_URL}`)
  const apiKey = await pairWithServer()
  const deviceId = Number(process.env.DEVICE_ID || '1')

  while (true) {
    await sendHeartbeat(apiKey, deviceId)
    await sleep(HEARTBEAT_INTERVAL_MS)
  }
}

main().catch((error) => {
  console.error('Agent error:', error.message)
  process.exit(1)
})
