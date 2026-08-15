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

  // Use PowerShell Get-CimInstance instead of `wmic`, which is removed by
  // default on Windows 11 24H2+. A single query returns CPU, memory, and disk.
  const ps = [
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -First 1',
    '[pscustomobject]@{',
    '  Cpu = [int]$cpu',
    '  FreeMem = [long]$os.FreePhysicalMemory',
    '  TotalMem = [long]$os.TotalVisibleMemorySize',
    '  FreeDisk = [long]$disk.FreeSpace',
    '  TotalDisk = [long]$disk.Size',
    '}',
  ].join('; ')

  const raw = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
    encoding: 'utf8',
    windowsHide: true,
  })

  // Parse the PowerShell object output:
  //   Cpu : 12
  //   FreeMem : 12345678
  //   TotalMem : 8388608
  //   FreeDisk : 123456789012
  //   TotalDisk : 234567890123
  const pick = (key) => {
    const match = raw.match(new RegExp(`${key}\\s*:\\s*([0-9]+)`, 'i'))
    return match ? Number(match[1]) : 0
  }

  const cpuUsage = pick('Cpu')

  // FreePhysicalMemory / TotalVisibleMemorySize are in KB.
  const freeKb = pick('FreeMem')
  const totalKb = pick('TotalMem')
  let memoryUsage = 0
  if (totalKb > 0) {
    memoryUsage = Math.max(0, Math.min(100, ((totalKb - freeKb) / totalKb) * 100))
  }

  const freeBytes = pick('FreeDisk')
  const totalBytes = pick('TotalDisk')
  let diskUsage = 0
  if (totalBytes > 0) {
    diskUsage = Math.max(0, Math.min(100, ((totalBytes - freeBytes) / totalBytes) * 100))
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
