/**
 * Agent helper functions
 * Provides reusable utilities for agent-related operations
 */

import bcrypt from 'bcryptjs'

import { getDb, withTransaction } from '../database/index.js'
import { broadcastState } from './ws.js'
import { isValidIp, isValidMac, normalizeIp, normalizeMac, normalizeUsage } from '../utils/validation.js'
import { generateApiKey } from '../utils/crypto.js'
import { STATUS_NOT_PAIRED, STATUS_ONLINE, STATUS_OFFLINE } from '../config/constants.js'

// Length of the first 12 characters of API key (stored as hint in DB)
export const API_KEY_HINT_LEN = 12

// handlePair 내부에서만 쓰는 신호용 에러. 페어링 코드가 없음/이미 사용됨/만료됨 중
// 어느 경우든 401 로 매핑되며, withTransaction 이 던져진 에러를 보고 롤백하게 만드는
// 용도로만 쓴다 (500 으로 새어 나가지 않도록 바깥에서 별도로 잡는다).
class InvalidPairingCodeError extends Error {}

// handlePair 내부에서만 쓰는 신호용 에러. 코드가 특정 기기에 묶여 있는데 요청의
// MAC 이 그 기기와 다르거나, 기기 미지정 코드로 이미 페어링된 기기를 재페어링
// 하려는 경우에 던진다. 409 로 매핑되며, withTransaction 이 롤백하게 만들어
// 코드가 소진되지 않도록 한다.
class PairingCodeDeviceMismatchError extends Error {}

/**
 * Extracts an API key from a Bearer authorization header
 * @param authHeader - The raw Authorization header value
 * @returns API key string (empty if not found)
 */
const extractApiKey = (authHeader: string): string => {
  if (!authHeader.startsWith('Bearer ')) return ''
  return authHeader.slice('Bearer '.length)
}

/**
 * Extracts the pairing request fields reported by the agent
 * @param body - Request body
 * @returns Object with pairingCode, macAddress, ipAddress and optional name
 */
const extractPairRequest = (body: any) => {
  const { pairingCode, macAddress, ipAddress, name } = (body || {}) as {
    pairingCode?: string
    macAddress?: string
    ipAddress?: string
    name?: string
  }
  return {
    pairingCode: pairingCode || '',
    macAddress: macAddress || '',
    ipAddress: ipAddress || '',
    name: typeof name === 'string' && name.trim() ? name.trim() : '',
  }
}

/**
 * Extracts usage metrics from a heartbeat request body
 * @param body - Request body
 * @returns Object with cpuUsage, memoryUsage, diskUsage, or null if missing
 */
const extractHeartbeatMetrics = (body: any) => {
  const { cpuUsage, memoryUsage, diskUsage } = (body || {}) as {
    cpuUsage?: number
    memoryUsage?: number
    diskUsage?: number
  }
  return {
    cpuUsage: cpuUsage ?? undefined,
    memoryUsage: memoryUsage ?? undefined,
    diskUsage: diskUsage ?? undefined,
  }
}

const AGENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * Extracts the optional agentVersion from a heartbeat request body.
 * 형식이 잘못되었거나 없으면 거절하지 않고 null 로 무시한다 (구버전 에이전트 호환).
 * @param body - Request body
 * @returns Trimmed version string, or null if missing/invalid
 */
const extractAgentVersion = (body: any): string | null => {
  const raw = (body || {}).agentVersion
  if (typeof raw !== 'string') return null
  const version = raw.trim()
  return version.length <= 32 && AGENT_VERSION_PATTERN.test(version) ? version : null
}

/**
 * Handles the agent pairing process.
 * 코드가 특정 기기로 지정되어 발급되었다면 그 기기의 MAC 과 요청의 MAC 이 일치할
 * 때만 재페어링을 허용한다. 기기 미지정 코드라면 검증에 성공한 이 시점에 에이전트가
 * 보고한 MAC/IP 로 기기 행을 만들거나(신규), 아직 페어링되지 않은 같은 MAC 의
 * 기존 행을 재사용한다 — 이미 페어링된 기기는 그 기기로 지정된 코드로만
 * 재페어링할 수 있다.
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Promise<void>
 */
export const handlePair = async (request: any, reply: any) => {
  const { pairingCode, macAddress, ipAddress, name } = extractPairRequest(request.body)
  if (!pairingCode || !macAddress || !ipAddress) {
    reply.code(400).send({ message: 'Pairing code, MAC address, and IP address are required' })
    return
  }
  if (!isValidMac(macAddress)) {
    reply.code(400).send({ message: 'Invalid MAC address' })
    return
  }
  if (!isValidIp(ipAddress)) {
    reply.code(400).send({ message: 'Invalid IP address' })
    return
  }

  const normalizedMac = normalizeMac(macAddress) as string
  const normalizedIp = normalizeIp(ipAddress) as string

  try {
    const agentKey = generateApiKey()
    const agentKeyHint = agentKey.substring(0, API_KEY_HINT_LEN)
    const agentKeyHash = await bcrypt.hash(agentKey, 10)
    const now = new Date().toISOString()

    const deviceId = await withTransaction(async (tx) => {
      // 코드의 존재/미사용/미만료 확인과 소진을 하나의 원자적 UPDATE 로 묶는다.
      // 이전에는 검사(SELECT)가 트랜잭션 밖의 평범한 db.get 이어서, 두 요청이
      // 동시에 같은 코드로 들어오면 둘 다 검사를 통과해 코드가 두 번 소진될 수
      // 있었다 (withTransaction 은 트랜잭션끼리만 직렬화하므로 트랜잭션 밖 조회는
      // 보호되지 않는다). 조건부 UPDATE 의 영향 행 수(changes)로만 판정하면
      // 검사와 소진 사이에 끼어들 틈이 없다.
      // expires_at 은 항상 new Date().toISOString() 로 저장되는 고정 자릿수의
      // UTC 문자열이므로, SQL 의 바이트 단위 문자열 비교가 시간 순서와 정확히
      // 일치한다 — 그래서 JS Date 비교 대신 SQL 비교를 그대로 쓴다.
      const result = await tx.run(
        'UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at >= ?',
        [now, pairingCode, now]
      )
      if (result.changes !== 1) {
        // 없음/이미 사용됨/만료됨 중 어느 경우인지는 응답에서 구분하지 않는다
        // (짐작으로 코드를 좁혀나가지 못하게 하기 위함). 원인별 로깅이 필요하면
        // 여기서 별도 SELECT 를 추가하되, 그 결과로 응답을 바꾸지는 않는다.
        throw new InvalidPairingCodeError()
      }
      const pairing = await tx.get('SELECT id, target_device_id FROM pairing_codes WHERE code = ?', [pairingCode])

      // Not yet ONLINE: the device has only just received its key and has
      // not sent a heartbeat yet.
      let id: number
      if (pairing.target_device_id !== null && pairing.target_device_id !== undefined) {
        // 특정 기기로 지정된 코드다. id 로 정확히 한 행만 골라내므로, 같은 MAC 을
        // 공유하는 중복 행이 남아있는 구 DB 에서도 모호함이 없다(신규 기기용
        // 분기와 달리 mac_address 로 조회하지 않는다).
        const targetDevice = await tx.get('SELECT id, mac_address FROM devices WHERE id = ?', [pairing.target_device_id])
        if (!targetDevice || targetDevice.mac_address !== normalizedMac) {
          throw new PairingCodeDeviceMismatchError('Pairing code is bound to a different device')
        }
        id = targetDevice.id
        // name 은 요청에 명시된 경우에만 갱신한다 — 관리자가 웹에서 바꿔 둔
        // 이름을 재페어링이 덮어쓰면 안 된다.
        await tx.run(
          'UPDATE devices SET name = COALESCE(?, name), agent_key_hash = ?, agent_key_hint = ?, agent_paired = 1, paired_at = ?, ip_address = ?, status = ?, updated_at = ? WHERE id = ?',
          [name || null, agentKeyHash, agentKeyHint, now, normalizedIp, STATUS_OFFLINE, now, id]
        )
      } else {
        // 기기 미지정(신규 기기용) 코드다. 같은 MAC 의 기존 행이 이미 페어링되어
        // 있다면 재페어링은 그 기기 앞으로 발급된 코드로만 허용된다 — 그렇지 않으면
        // 아무 신규 기기용 코드로도 이미 페어링된 기기를 가로챌 수 있게 된다.
        // 아직 페어링되지 않은 행(웹에서 수동 등록했거나 이전에 unpair 된 경우)은
        // 그대로 채택한다.
        // mac_address 에는 UNIQUE 인덱스가 있지만, 중복이 이미 남아있던 구 DB 에서는
        // 인덱스 생성이 건너뛰어질 수 있다(database/schema.ts 참고). 그런 DB 에서는
        // 같은 MAC 의 행이 여러 개일 수 있으므로, "이미 페어링됨" 판정은 그 중
        // 채택 대상이 될 행 하나만 보지 않고 같은 MAC 을 가진 모든 행을 확인한다 —
        // 그렇지 않으면 페어링된 행 옆의 미페어링 중복 행을 골라 우회할 수 있다.
        const pairedConflict = await tx.get(
          'SELECT id FROM devices WHERE mac_address = ? AND agent_paired = 1 LIMIT 1',
          [normalizedMac]
        )
        if (pairedConflict) {
          throw new PairingCodeDeviceMismatchError('Device is already paired; issue a pairing code from that device\'s entry to re-pair')
        }

        // 이 시점에는 같은 MAC 의 모든 행이 미페어링 상태임이 보장된다.
        // ORDER BY id ASC LIMIT 1 로 항상 가장 오래된 행을 결정적으로 채택해,
        // 중복이 남아있는 DB 에서도 어느 행이 뽑힐지가 조회마다 달라지지 않게 한다.
        const existing = await tx.get(
          'SELECT id FROM devices WHERE mac_address = ? ORDER BY id ASC LIMIT 1',
          [normalizedMac]
        )

        if (existing) {
          id = existing.id
          await tx.run(
            'UPDATE devices SET name = COALESCE(?, name), agent_key_hash = ?, agent_key_hint = ?, agent_paired = 1, paired_at = ?, ip_address = ?, status = ?, updated_at = ? WHERE id = ?',
            [name || null, agentKeyHash, agentKeyHint, now, normalizedIp, STATUS_OFFLINE, now, id]
          )
        } else {
          const deviceName = name || `Agent-${normalizedMac.replace(/:/g, '').slice(-6)}`
          const insertResult = await tx.run(
            'INSERT INTO devices (name, mac_address, ip_address, agent_key_hash, agent_key_hint, agent_paired, paired_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
            [deviceName, normalizedMac, normalizedIp, agentKeyHash, agentKeyHint, now, STATUS_OFFLINE, now]
          )
          id = insertResult.lastID
        }
      }

      // 어떤 코드로 어떤 기기가 붙었는지 감사 흔적을 남긴다.
      await tx.run('UPDATE pairing_codes SET device_id = ? WHERE id = ?', [id, pairing.id])
      return id
    })

    // This is already persisted at this point, so a broadcast failure must
    // not turn into a 500 — the agent would keep retrying an accepted pair.
    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after pairing:', broadcastError)
    }

    // agentKey is plaintext and is only ever exposed in this one response;
    // the server retains only its bcrypt hash from this point on.
    reply.send({ deviceId, apiKey: agentKey })
  } catch (error) {
    if (error instanceof InvalidPairingCodeError) {
      console.warn('Pairing attempt with invalid, already-used, or expired code')
      reply.code(401).send({ message: 'Invalid pairing code' })
      return
    }
    if (error instanceof PairingCodeDeviceMismatchError) {
      console.warn('Pairing attempt with a code not valid for the reported device')
      reply.code(409).send({ message: error.message })
      return
    }
    console.error('Error during agent pairing:', error)
    reply.code(500).send({ message: 'Internal server error during pairing' })
  }
}

/**
 * Handles the agent heartbeat process.
 * Updates device last_seen and processes metrics.
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns Promise<void>
 */
export const handleHeartbeat = async (request: any, reply: any) => {
  const authHeader = request.headers.authorization || ''
  const agentKey = extractApiKey(authHeader)
  if (!agentKey) {
    reply.code(401).send({ message: 'Invalid or missing API key' })
    return
  }

  const metrics = extractHeartbeatMetrics(request.body)
  const agentVersion = extractAgentVersion(request.body)
  const db = getDb()

  try {
    // Find the candidate device by the key hint, then verify the full key
    // against the bcrypt hash — the hint alone is not proof of possession.
    const device = await db.get(
      'SELECT id, agent_key_hash, agent_paired FROM devices WHERE agent_key_hint = ?',
      [agentKey.substring(0, API_KEY_HINT_LEN)]
    )

    if (!device || !device.agent_key_hash || !(await bcrypt.compare(agentKey, device.agent_key_hash))) {
      reply.code(401).send({ message: 'Invalid or missing API key' })
      return
    }

    if (device.agent_paired !== 1) {
      reply.code(403).send({ message: 'Device is not paired' })
      return
    }

    for (const [key, value] of Object.entries(metrics)) {
      if (value !== undefined && normalizeUsage(value) === null) {
        reply.code(400).send({ message: `Invalid ${key}` })
        return
      }
    }

    const deviceId = device.id
    const now = new Date().toISOString()

    // updated_at is also bumped here: this is a genuine state change
    // (status/last_seen), and any prior WAKE_TIMEOUT status is being
    // overwritten to ONLINE in this same statement, so the WAKE_TIMEOUT
    // deadline logic in deviceStatus.ts (which only reads updated_at while
    // status is still WAKE_TIMEOUT) is unaffected.
    const heartbeatApplied = await withTransaction(async (tx) => {
      const result = await tx.run(
        'UPDATE devices SET last_seen = ?, status = ?, updated_at = ?, agent_version = COALESCE(?, agent_version) WHERE id = ? AND agent_paired = 1 AND agent_key_hash = ? AND agent_key_hint = ?',
        [now, STATUS_ONLINE, now, agentVersion, deviceId, device.agent_key_hash, agentKey.substring(0, API_KEY_HINT_LEN)]
      )
      if (result.changes !== 1) return false

      if (metrics.cpuUsage !== undefined || metrics.memoryUsage !== undefined || metrics.diskUsage !== undefined) {
        await tx.run(
          'INSERT INTO device_metrics_latest (device_id, cpu_usage, memory_usage, disk_usage, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(device_id) DO UPDATE SET cpu_usage=excluded.cpu_usage, memory_usage=excluded.memory_usage, disk_usage=excluded.disk_usage, updated_at=excluded.updated_at',
          [deviceId, metrics.cpuUsage, metrics.memoryUsage, metrics.diskUsage, now]
        )

        await tx.run(
          'INSERT INTO device_metrics_history (device_id, timestamp, cpu_usage, memory_usage, disk_usage) VALUES (?, ?, ?, ?, ?)',
          [deviceId, now, metrics.cpuUsage, metrics.memoryUsage, metrics.diskUsage]
        )
      }

      return true
    })

    if (!heartbeatApplied) {
      reply.code(401).send({ message: 'Invalid or missing API key' })
      return
    }

    // The heartbeat is already persisted at this point, so a broadcast failure
    // must not return 500 — the agent would keep retrying an accepted heartbeat.
    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after heartbeat:', broadcastError)
    }

    reply.send({ status: 'ok' })
  } catch (error) {
    console.error('Error during agent heartbeat:', error)
    reply.code(500).send({ message: 'Internal server error during heartbeat' })
  }
}

export const handleUnpair = async (request: any, reply: any) => {
  const agentKey = extractApiKey(request.headers.authorization || '')
  if (!agentKey) {
    reply.code(401).send({ message: 'Invalid or missing API key' })
    return
  }

  const agentKeyHint = agentKey.substring(0, API_KEY_HINT_LEN)
  const db = getDb()

  try {
    const device = await db.get(
      'SELECT id, agent_key_hash, agent_paired FROM devices WHERE agent_key_hint = ?',
      [agentKeyHint]
    )

    if (!device || !device.agent_key_hash || !(await bcrypt.compare(agentKey, device.agent_key_hash))) {
      reply.code(401).send({ message: 'Invalid or missing API key' })
      return
    }

    if (device.agent_paired !== 1) {
      reply.code(403).send({ message: 'Device is not paired' })
      return
    }

    const now = new Date().toISOString()
    const unpaired = await withTransaction(async (tx) => {
      const result = await tx.run(
        'UPDATE devices SET agent_key_hash = NULL, agent_key_hint = NULL, agent_paired = 0, paired_at = NULL, last_seen = NULL, status = ?, updated_at = ? WHERE id = ? AND agent_paired = 1 AND agent_key_hash = ? AND agent_key_hint = ?',
        [STATUS_NOT_PAIRED, now, device.id, device.agent_key_hash, agentKeyHint]
      )
      if (result.changes !== 1) return false
      await tx.run('DELETE FROM device_metrics_latest WHERE device_id = ?', [device.id])
      return true
    })

    if (!unpaired) {
      reply.code(401).send({ message: 'Invalid or missing API key' })
      return
    }

    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after unpairing:', broadcastError)
    }

    reply.send({ status: 'ok' })
  } catch (error) {
    console.error('Error during agent unpairing:', error)
    reply.code(500).send({ message: 'Internal server error during unpairing' })
  }
}
