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

const getWindowsMetrics = async () => {
  const { execSync } = require('node:child_process')

  const cpu = execSync('wmic cpu get LoadPercentage /value', { encoding: 'utf8' })
  const memory = execSync('wmic OS get FreePhysicalMemory /value', { encoding: 'utf8' })
  const disk = execSync('wmic logicaldisk get FreeSpace,Size /value', { encoding: 'utf8' })

  const cpuMatch = cpu.match(/LoadPercentage=([0-9]+)/i)
  const freeMemMatch = memory.match(/FreePhysicalMemory=([0-9]+)/i)

  const cpuUsage = cpuMatch ? Number(cpuMatch[1]) : 0

  let memoryUsage = 0
  if (freeMemMatch) {
    const freeMb = Number(freeMemMatch[1]) / 1024
    const totalMb = 4096
    memoryUsage = Math.max(0, Math.min(100, ((totalMb - freeMb) / totalMb) * 100))
  }

  const diskMatch = [...disk.matchAll(/FreeSpace=([0-9]+)/gi)]
  const sizeMatch = [...disk.matchAll(/Size=([0-9]+)/gi)]

  let diskUsage = 0
  if (diskMatch.length && sizeMatch.length) {
    const freeBytes = Number(diskMatch[0][1])
    const totalBytes = Number(sizeMatch[0][1])
    if (totalBytes > 0) {
      diskUsage = Math.max(0, Math.min(100, ((totalBytes - freeBytes) / totalBytes) * 100))
    }
  }

  return {
    cpuUsage,
    memoryUsage: Number(memoryUsage.toFixed(1)),
    diskUsage: Number(diskUsage.toFixed(1)),
  }
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

  console.log('Window Agent paired successfully')
  console.log(`deviceId: ${data.deviceId}`)
  console.log(`apiKey: ${data.apiKey}`)
  return data.apiKey
}

const sendHeartbeat = async (apiKey, deviceId) => {
  const metrics = await getWindowsMetrics()

  const payload = {
    deviceId,
    cpuUsage: metrics.cpuUsage,
    memoryUsage: metrics.memoryUsage,
    diskUsage: metrics.diskUsage,
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
  console.log('metrics:', payload)
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
