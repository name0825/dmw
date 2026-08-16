import { randomBytes } from 'node:crypto'

import { db } from '../db.js'
import { evaluateAlerts } from '../alerts.js'
import { broadcastState } from '../ws.js'
import { isValidIp, isValidMac, normalizeIp, normalizeMac } from '../validation.js'
import { sendWakePacket } from '../services/wake.js'

// 페어링 코드 유효기간 (10분)
const PAIRING_TTL_MS = 10 * 60 * 1000
const DEVICE_WAKE_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }

// 기기 상태 상수. 매직 문자열을 상수로 분리해 오타와 일관성 문제를 방지한다.
const STATUS_NOT_PAIRED = 'NOT_PAIRED'
const STATUS_ONLINE = 'ONLINE'
const STATUS_WAKE_TIMEOUT = 'WAKE_TIMEOUT'

/**
 * 페어링 코드를 생성해 DB에 저장한다.
 * @param {number} deviceId - 페어링 대상 기기 id
 * @param {string} nowIso - 현재 시각 ISO 문자열
 * @returns {Promise<{ pairingCode: string; expiresAt: string }>} 생성된 코드와 만료 시각
 */
const createPairingCode = async (deviceId: number, nowIso: string) => {
  const pairingCode = randomBytes(4).toString('hex').toUpperCase()
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()

  await db.run(
    'INSERT INTO pairing_codes (device_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [deviceId, pairingCode, expiresAt, nowIso],
  )

  return { pairingCode, expiresAt }
}

/**
 * 기기 등록/수정 요청 바디를 검증하고 정규화된 필드를 반환한다.
 * @param {any} body - 요청 바디
 * @param {boolean} requireAll - true이면 모든 필드가 필수(등록), false이면 선택(수정)
 * @returns {{ error?: string; fields?: Record<string, string> }} 검증 실패 시 error, 성공 시 정규화 필드
 */
const validateDeviceBody = (body: any, requireAll: boolean) => {
  const { name, mac_address, ip_address } = (body || {}) as {
    name?: string
    mac_address?: string
    ip_address?: string
  }

  if (requireAll && (!name || !mac_address || !ip_address)) {
    return { error: 'Missing required fields' }
  }

  if (mac_address && !isValidMac(mac_address)) {
    return { error: 'Invalid MAC address. Expected format AA:BB:CC:DD:EE:FF' }
  }

  if (ip_address && !isValidIp(ip_address)) {
    return { error: 'Invalid IP address. Expected IPv4 format (e.g. 192.168.0.20)' }
  }

  const fields: Record<string, string> = {}
  if (name) fields.name = name
  if (mac_address) fields.mac_address = normalizeMac(mac_address) as string
  if (ip_address) fields.ip_address = normalizeIp(ip_address) as string

  return { fields }
}

/**
 * 기기 관리 라우트(dashboard, devices CRUD, wake, alerts)를 등록한다.
 * @param {any} app - Fastify app 인스턴스
 */
export const registerDeviceRoutes = (app: any) => {
  app.get('/dashboard', async () => {
    const devices = await db.all('SELECT * FROM devices ORDER BY id DESC')
    return {
      total: devices.length,
      online: devices.filter((device: any) => device.status === STATUS_ONLINE).length,
      offline: devices.filter((device: any) => device.status === 'OFFLINE').length,
      notPaired: devices.filter((device: any) => device.agent_paired === 0).length,
    }
  })

  app.get('/devices', async () => {
    const devices = await db.all(`
      SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage, m.updated_at AS metrics_updated_at
      FROM devices d
      LEFT JOIN device_metrics_latest m ON m.device_id = d.id
      ORDER BY d.id DESC
    `)
    return { devices }
  })

  app.get('/devices/:id/history', async (request: any) => {
    const { id } = request.params
    const history = await db.all(
      'SELECT * FROM device_metrics_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 10',
      [id],
    )

    return { history }
  })

  app.get('/alerts', async () => {
    const devices = await db.all(`
      SELECT d.*, m.cpu_usage, m.memory_usage, m.disk_usage
      FROM devices d
      LEFT JOIN device_metrics_latest m ON m.device_id = d.id
      ORDER BY d.id DESC
    `)

    return { alerts: devices.flatMap((device: any) => evaluateAlerts(device)) }
  })

  app.post('/devices', async (request: any, reply: any) => {
    const { error, fields } = validateDeviceBody(request.body, true)
    if (error) {
      reply.code(400).send({ message: error })
      return
    }

    const nowIso = new Date().toISOString()
    const result = await db.run(
      'INSERT INTO devices (name, mac_address, ip_address, status, agent_paired, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [fields!.name, fields!.mac_address, fields!.ip_address, STATUS_NOT_PAIRED, nowIso, nowIso],
    )

    const deviceId = Number((result as any).lastID)
    const { pairingCode, expiresAt } = await createPairingCode(deviceId, nowIso)

    await broadcastState()
    return { deviceId, pairingCode, expiresAt }
  })

  app.patch('/devices/:id', async (request: any, reply: any) => {
    const { id } = request.params
    const { error, fields } = validateDeviceBody(request.body, false)
    if (error) {
      reply.code(400).send({ message: error })
      return
    }

    if (!fields || !Object.keys(fields).length) {
      return { message: 'No changes provided' }
    }

    // FIXED: SET 절은 화이트리스트 컬럼만 사용한다.
    // validateDeviceBody가 name/mac_address/ip_address만 채우므로 현재는 안전하지만,
    // 향후 필드가 추가될 때 임의 컬럼명이 SQL SET 절에 들어가는 것을 원천 차단한다.
    const UPDATABLE_COLUMNS = ['name', 'mac_address', 'ip_address']
    const setClauses: string[] = []
    const values: string[] = []
    for (const column of UPDATABLE_COLUMNS) {
      if (fields[column] !== undefined) {
        setClauses.push(`${column} = ?`)
        values.push(fields[column])
      }
    }
    values.push(new Date().toISOString(), id)

    await db.run(`UPDATE devices SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`, values)
    await broadcastState()
    return { message: 'Device updated' }
  })

  app.delete('/devices/:id', async (request: any) => {
    const { id } = request.params
    await db.run('DELETE FROM devices WHERE id = ?', [id])
    await db.run('DELETE FROM pairing_codes WHERE device_id = ?', [id])
    await db.run('DELETE FROM device_metrics_latest WHERE device_id = ?', [id])
    await broadcastState()
    return { message: 'Device deleted' }
  })

  app.post('/devices/:id/wake', { config: { rateLimit: DEVICE_WAKE_RATE_LIMIT } }, async (request: any, reply: any) => {
    const { id } = request.params
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [id])

    if (!device) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    if (!device.agent_paired) {
      reply.code(400).send({ message: 'Device is not paired yet' })
      return
    }

    if (device.status === STATUS_ONLINE) {
      return { message: 'Device is already online' }
    }

    try {
      await sendWakePacket(device.mac_address, device.ip_address)

      await db.run('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?', [STATUS_WAKE_TIMEOUT, new Date().toISOString(), id])
      await broadcastState()
      return { message: 'Wake packet sent' }
    } catch {
      // FIXED: 예외 문자열을 그대로 클라이언트에 반환하지 않는다.
      // 내부 오류 상세(패킷 주소, 라이브러리 스택 등)가 노출되는 정보 누출을 막기 위해
      // 고정 메시지만 반환한다.
      reply.code(500).send({ message: 'Failed to send WOL packet' })
    }
  })
}
