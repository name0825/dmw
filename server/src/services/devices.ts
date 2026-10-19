import { STATUS_NOT_PAIRED, STATUS_WAKE_TIMEOUT } from '../config/constants.js'
import { getDb, withTransaction } from '../database/index.js'
import { isValidIp, isValidMac, normalizeIp, normalizeMac } from '../utils/validation.js'
import { sendWakePacket } from './wake.js'
import { broadcastState } from './ws.js'

const MAX_DEVICE_NAME_LENGTH = 100

/**
 * Handles getting the dashboard summary.
 */
export const handleGetDashboard = async (_request: any, reply: any) => {
  const db = getDb()
  try {
    const [devices, onlineDevices, alerts] = await Promise.all([
      db.all('SELECT COUNT(*) as count FROM devices'),
      db.get('SELECT COUNT(*) as count FROM devices WHERE status = "ONLINE"'),
      db.all('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5')
    ])

    reply.send({
      totalDevices: devices[0].count,
      onlineDevices: onlineDevices.count,
      recentAlerts: alerts
    })
  } catch (error) {
    console.error('Error getting dashboard:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting the list of all devices.
 */
export const handleGetDevices = async (_request: any, reply: any) => {
  const db = getDb()
  try {
    const devices = await db.all(
      // agent_key_hash / agent_key_hint 는 의도적으로 제외한다. 둘 다 에이전트
      // API Key 에서 파생된 값이라 브라우저로 내보낼 이유가 없다.
      `SELECT devices.id, devices.name, devices.mac_address, devices.ip_address,
              devices.agent_paired, devices.paired_at, devices.last_seen, devices.status, devices.agent_version,
              devices.created_at, devices.updated_at,
              devices.ssh_username, devices.ssh_port, devices.ssh_host_key,
              device_metrics_latest.cpu_usage, device_metrics_latest.memory_usage, device_metrics_latest.disk_usage
       FROM devices
       LEFT JOIN device_metrics_latest ON device_metrics_latest.device_id = devices.id
       ORDER BY devices.last_seen DESC`
    )
    reply.send({ devices })
  } catch (error) {
    console.error('Error getting devices:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting device history.
 */
export const handleGetDeviceHistory = async (request: any, reply: any) => {
  const { id } = request.params
  const deviceId = Number(id)
  if (!Number.isInteger(deviceId)) {
    reply.code(400).send({ message: 'Invalid device id' })
    return
  }

  const db = getDb()
  try {
    const history = await db.all(
      'SELECT * FROM device_metrics_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 50',
      [deviceId]
    )
    reply.send({ history })
  } catch (error) {
    console.error('Error getting device history:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles getting recent alerts.
 */
export const handleGetAlerts = async (_request: any, reply: any) => {
  const db = getDb()
  try {
    const alerts = await db.all(
      `SELECT id, device_id AS deviceId, level, metric, value, message, created_at
       FROM alerts
       ORDER BY created_at DESC LIMIT 50`
    )
    reply.send({ alerts })
  } catch (error) {
    console.error('Error getting alerts:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles creating a new device manually.
 * 에이전트 없이 WOL 만 사용하는 기기를 위한 경로다. 페어링 코드는 여기서
 * 발급하지 않는다 — 코드는 POST /pairing-codes 에서 기기와 무관하게 발급되고,
 * 기기 행은 에이전트가 페어링에 성공하는 시점에 생성/재사용된다.
 */
export const handleCreateDevice = async (request: any, reply: any) => {
  const body = request.body ?? {}
  const { mac_address, ip_address } = body
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > MAX_DEVICE_NAME_LENGTH || !isValidMac(mac_address) || !isValidIp(ip_address)) {
    reply.code(400).send({ message: 'Valid name, MAC address, and IP address are required' })
    return
  }

  const normalizedMac = normalizeMac(mac_address)
  const normalizedIp = normalizeIp(ip_address)

  const db = getDb()
  try {
    // devices(mac_address) 는 UNIQUE 제약이 있다. 아래 사전 SELECT 는 정상 경로에서
    // 친절한 409 메시지를 주기 위한 것이고, 동시 요청으로 이 검사를 함께 통과하는
    // 경합은 INSERT 의 제약 위반을 잡아 아래에서 동일하게 처리한다.
    const existing = await db.get('SELECT id FROM devices WHERE mac_address = ?', [normalizedMac])
    if (existing) {
      reply.code(409).send({ message: 'A device with this MAC address already exists' })
      return
    }

    let result
    try {
      result = await withTransaction(async (tx) => {
        return tx.run(
          'INSERT INTO devices (name, mac_address, ip_address, status) VALUES (?, ?, ?, ?)',
          [name, normalizedMac, normalizedIp, STATUS_NOT_PAIRED]
        )
      })
    } catch (error) {
      const isDuplicate = String((error as any)?.code || '').startsWith('SQLITE_CONSTRAINT')
      if (isDuplicate) {
        reply.code(409).send({ message: 'A device with this MAC address already exists' })
        return
      }
      throw error
    }

    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after device creation:', broadcastError)
    }

    reply.code(201).send({
      deviceId: result.lastID,
      name,
      mac_address: normalizedMac,
      ip_address: normalizedIp,
    })
  } catch (error) {
    console.error('Error creating device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles updating an existing device.
 */
export const handleUpdateDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const body = request.body ?? {}
  const { mac_address, ip_address } = body
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > MAX_DEVICE_NAME_LENGTH || !isValidMac(mac_address) || !isValidIp(ip_address)) {
    reply.code(400).send({ message: 'Valid name, MAC address, and IP address are required' })
    return
  }

  const normalizedMac = normalizeMac(mac_address)
  const normalizedIp = normalizeIp(ip_address)

  const db = getDb()
  try {
    const existing = await db.get('SELECT id FROM devices WHERE id = ?', [id])
    if (!existing) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    // devices(mac_address) 는 UNIQUE 제약이 있다. 아래 사전 SELECT 는 정상 경로에서
    // 친절한 409 메시지를 주기 위한 것이고(자기 자신과의 충돌은 제외한다), 동시
    // 요청으로 이 검사를 함께 통과하는 경합은 UPDATE 의 제약 위반을 잡아 아래에서
    // 동일하게 처리한다.
    const duplicate = await db.get('SELECT id FROM devices WHERE mac_address = ? AND id != ?', [normalizedMac, id])
    if (duplicate) {
      reply.code(409).send({ message: 'A device with this MAC address already exists' })
      return
    }

    try {
      // status is intentionally left untouched. updated_at also doubles as the
      // instant the WOL packet was sent: evaluateDeviceStatus measures the
      // WAKE_TIMEOUT deadline from it. Bumping it while the device is still
      // WAKE_TIMEOUT would restart the 3-minute wake timer just because an admin
      // renamed the device, so the timestamp is left alone in that state only.
      // status 는 이 UPDATE 문 실행 시점의 값을 기준으로 CASE 안에서 함께 읽고
      // 쓴다 — 별도 SELECT 로 미리 읽으면 그 사이 wake/updateOfflineStates 가
      // status 를 바꿔 잘못된 분기를 타는 경합이 생긴다.
      const result = await withTransaction(async (tx) => {
        return tx.run(
          'UPDATE devices SET name = ?, mac_address = ?, ip_address = ?, updated_at = CASE WHEN status = ? THEN updated_at ELSE ? END WHERE id = ?',
          [name, normalizedMac, normalizedIp, STATUS_WAKE_TIMEOUT, new Date().toISOString(), id]
        )
      })
      if (result.changes === 0) {
        // 존재 확인(SELECT) 과 UPDATE 사이에 다른 요청이 이 디바이스를 삭제한 경우.
        reply.code(404).send({ message: 'Device not found' })
        return
      }
    } catch (error) {
      const isDuplicate = String((error as any)?.code || '').startsWith('SQLITE_CONSTRAINT')
      if (isDuplicate) {
        reply.code(409).send({ message: 'A device with this MAC address already exists' })
        return
      }
      throw error
    }

    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after device update:', broadcastError)
    }

    reply.send({ message: 'Device updated successfully' })
  } catch (error) {
    console.error('Error updating device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles deleting a device.
 */
export const handleDeleteDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const db = getDb()
  try {
    const existing = await db.get('SELECT id FROM devices WHERE id = ?', [id])
    if (!existing) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    await withTransaction(async (tx) => {
      await tx.run('DELETE FROM devices WHERE id = ?', [id])
    })

    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after device deletion:', broadcastError)
    }

    reply.send({ message: 'Device deleted successfully' })
  } catch (error) {
    console.error('Error deleting device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}

/**
 * Handles Wake-on-LAN request.
 * Sends a WOL packet to the device. A paired device then moves to WAKE_TIMEOUT
 * until its agent reports back; an unpaired one keeps its status because nothing
 * would ever clear the timeout.
 */
export const handleWakeDevice = async (request: any, reply: any) => {
  const { id } = request.params
  const db = getDb()
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [id])
    if (!device) {
      reply.code(404).send({ message: 'Device not found' })
      return
    }

    // The broadcast address is derived from the device IP, so a device recorded
    // without one (agents may self-register before an address is known) cannot
    // be targeted.
    if (!device.mac_address || !device.ip_address) {
      reply.code(422).send({ message: 'Device is missing a MAC or IP address' })
      return
    }

    try {
      await sendWakePacket(device.mac_address, device.ip_address)
    } catch (error) {
      // FIXED: the previous stub reported success unconditionally. A failed send
      // must not move the device into WAKE_TIMEOUT, or the UI would wait three
      // minutes on a packet that never left the host.
      console.error('Error sending WOL packet:', error)
      reply.code(502).send({ message: 'Failed to send Wake-on-LAN packet' })
      return
    }

    // An unpaired device has no agent to report back, so WAKE_TIMEOUT would
    // always decay to OFFLINE and read as a WOL failure. The packet is still
    // useful — WOL works without an agent — so send it but leave the status
    // alone and tell the caller why the result cannot be confirmed.
    if (!device.agent_paired) {
      reply.send({
        message: 'Wake-on-LAN signal sent. Agent is not paired, so power state cannot be confirmed.',
        device: device.name,
        agentPaired: false,
      })
      return
    }

    // updated_at doubles as the wake timestamp that evaluateDeviceStatus counts
    // the three-minute WAKE_TIMEOUT window from.
    await withTransaction(async (tx) => {
      await tx.run(
        'UPDATE devices SET status = ?, updated_at = ? WHERE id = ?',
        [STATUS_WAKE_TIMEOUT, new Date().toISOString(), id]
      )
    })
    // The packet is already out and the status committed, so a broadcast failure
    // must not turn a successful wake into a 500 — the caller would retry a wake
    // that actually worked.
    try {
      await broadcastState()
    } catch (broadcastError) {
      console.error('Error broadcasting state after wake:', broadcastError)
    }

    reply.send({ message: 'Wake-on-LAN signal sent', device: device.name })
  } catch (error) {
    console.error('Error waking device:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}
