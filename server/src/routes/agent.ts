import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

import { db } from '../db.js'
import { broadcastState } from '../ws.js'

const AGENT_PAIR_RATE_LIMIT = { max: 5, timeWindow: '1 minute' }

// API 키의 첫 12자. DB에 힌트로 저장해 bcrypt 비교 대상 후보를 1행으로 좁힌다.
const API_KEY_HINT_LEN = 12

// 기기 상태 상수
const STATUS_ONLINE = 'ONLINE'

/**
 * Bearer 헤더에서 API 키를 추출한다.
 * @param {string} authHeader - Authorization 헤더 원문
 * @returns {string} API 키 (없으면 빈 문자열)
 */
const extractApiKey = (authHeader: string): string => {
  if (!authHeader.startsWith('Bearer ')) return ''
  return authHeader.slice('Bearer '.length)
}

/**
 * 0~100 범위의 사용률 값을 검증한다.
 * @param {unknown} value - 요청 바디에서 받은 값
 * @returns {number | null} 유효하면 숫자, 아니면 null
 */
const normalizeUsage = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

/**
 * 에이전트(기기 측) 라우트(/agent/pair, /agent/heartbeat)를 등록한다.
 * 이 라우트들은 공개 라우트로, JWT 대신 페어링 코드/API 키로 인증한다.
 * @param {any} app - Fastify app 인스턴스
 */
export const registerAgentRoutes = (app: any) => {
  app.post('/agent/pair', { config: { rateLimit: AGENT_PAIR_RATE_LIMIT } }, async (request: any, reply: any) => {
    const { ip, pairingCode } = (request.body || {}) as { ip?: string; pairingCode?: string }
    if (!ip || !pairingCode) {
      reply.code(400).send({ message: 'IP and pairing code required' })
      return
    }

    const activeCode = await db.get(
      'SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
      [pairingCode, new Date().toISOString()],
    )

    if (!activeCode) {
      reply.code(400).send({ message: 'Pairing code invalid or expired' })
      return
    }

    const device = await db.get('SELECT * FROM devices WHERE id = ?', [activeCode.device_id])
    if (!device) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    const apiKey = randomBytes(24).toString('hex')
    const apiKeyHash = await bcrypt.hash(apiKey, 10)
    const apiKeyHint = apiKey.slice(0, API_KEY_HINT_LEN)
    const now = new Date().toISOString()

    await db.run(
      'UPDATE devices SET agent_key_hash = ?, agent_key_hint = ?, agent_paired = 1, paired_at = ?, last_seen = ?, status = ?, updated_at = ? WHERE id = ?',
      [apiKeyHash, apiKeyHint, now, now, STATUS_ONLINE, now, device.id],
    )
    await db.run('UPDATE pairing_codes SET used_at = ? WHERE id = ?', [now, activeCode.id])
    await broadcastState()

    return { apiKey, deviceId: device.id }
  })

  app.post('/agent/heartbeat', async (request: any, reply: any) => {
    const apiKey = extractApiKey(request.headers.authorization || '')

    if (!apiKey) {
      reply.code(401).send({ message: 'Missing API key' })
      return
    }

    const apiKeyHint = apiKey.slice(0, API_KEY_HINT_LEN)
    const matchedDevice = await db.get('SELECT * FROM devices WHERE agent_paired = 1 AND agent_key_hint = ?', [apiKeyHint])
    if (!matchedDevice) {
      reply.code(401).send({ message: 'Invalid API key' })
      return
    }

    const isValidApiKey = await bcrypt.compare(apiKey, matchedDevice.agent_key_hash)
    if (!isValidApiKey) {
      reply.code(401).send({ message: 'Invalid API key' })
      return
    }

    const { cpuUsage, memoryUsage, diskUsage } = (request.body || {}) as {
      cpuUsage?: number
      memoryUsage?: number
      diskUsage?: number
    }

    // FIXED: 사용률 값을 검증한다. 기존엔 문자열/NaN/음수/100 초과 값이
    // DB에 그대로 저장되어 대시보드/경보 계산이 깨질 수 있었다.
    // 유효하지 않으면 0으로 처리(기존 `?? 0` 폴백과 동일한 기본값).
    const cpu = normalizeUsage(cpuUsage) ?? 0
    const memory = normalizeUsage(memoryUsage) ?? 0
    const disk = normalizeUsage(diskUsage) ?? 0

    const now = new Date().toISOString()
    await db.run(
      'UPDATE devices SET last_seen = ?, status = ?, updated_at = ? WHERE id = ?',
      [now, STATUS_ONLINE, now, matchedDevice.id],
    )
    await db.run(
      'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET cpu_usage = excluded.cpu_usage, memory_usage = excluded.memory_usage, disk_usage = excluded.disk_usage, updated_at = excluded.updated_at',
      [matchedDevice.id, cpu, memory, disk, now],
    )
    await db.run(
      'INSERT INTO device_metrics_history (device_id, timestamp, cpu_usage, memory_usage, disk_usage) VALUES (?, ?, ?, ?, ?)',
      [matchedDevice.id, now, cpu, memory, disk],
    )
    await broadcastState()

    return { message: 'Heartbeat received' }
  })
}
