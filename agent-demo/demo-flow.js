require('dotenv').config()

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dmw.local'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const DEVICE_NAME = process.env.DEVICE_NAME || 'Demo Windows PC'
const DEVICE_MAC = process.env.DEVICE_MAC || 'AA:BB:CC:DD:EE:FF'
const DEVICE_IP = process.env.DEVICE_IP || '192.168.0.50'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  console.log('1) 관리자 로그인 중...')
  const loginRes = await requestJson(`${SERVER_URL}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })

  const accessToken = loginRes.accessToken
  console.log('로그인 성공')

  console.log('2) 디바이스 등록 중...')
  const deviceRes = await requestJson(`${SERVER_URL}/devices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      name: DEVICE_NAME,
      mac_address: DEVICE_MAC,
      ip_address: DEVICE_IP,
    }),
  })

  console.log('디바이스 등록 완료')
  console.log(`pairingCode: ${deviceRes.pairingCode}`)

  console.log('3) Agent 페어링 중...')
  const pairRes = await requestJson(`${SERVER_URL}/agent/pair`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ip: DEVICE_IP,
      pairingCode: deviceRes.pairingCode,
    }),
  })

  const apiKey = pairRes.apiKey
  console.log('페어링 완료')
  console.log(`apiKey: ${apiKey}`)

  console.log('4) heartbeat 전송 중...')
  const heartbeatRes = await requestJson(`${SERVER_URL}/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      deviceId: pairRes.deviceId,
      cpuUsage: 42.1,
      memoryUsage: 58.7,
      diskUsage: 63.4,
    }),
  })

  console.log('heartbeat 전송 완료')
  console.log(heartbeatRes.message)

  console.log('5) 디바이스 목록 확인 중...')
  const devicesRes = await requestJson(`${SERVER_URL}/devices`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  console.log('최종 디바이스 상태:')
  console.log(JSON.stringify(devicesRes.devices, null, 2))
}

main().catch((error) => {
  console.error('Demo flow failed:', error.message)
  process.exit(1)
})
