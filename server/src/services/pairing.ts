/**
 * Pairing code service.
 * 페어링 코드는 기기와 무관하게 발급된다. 코드에 기기가 묶이는 시점은
 * 에이전트가 코드를 소진하는 순간(services/agent.ts 의 handlePair)이다.
 */

import { randomBytes } from 'node:crypto'

import { PAIRING_TTL_MS } from '../config/constants.js'
import { getDb, withTransaction } from '../database/index.js'

/**
 * Inserts a fresh pairing code and returns it.
 * The code is only 32 bits of randomness and pairing_codes(code) is UNIQUE, so a
 * collision is possible; retry exactly once rather than surfacing a raw 500.
 * A second collision is astronomically unlikely and is left to the caller's 500
 * handler — retrying in a loop would only hide a real constraint problem.
 */
const insertPairingCode = async (db: any, expiresAt: string, targetDeviceId: number | null = null): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    const code = randomBytes(4).toString('hex').toUpperCase()
    try {
      await db.run('INSERT INTO pairing_codes (code, expires_at, target_device_id) VALUES (?, ?, ?)', [code, expiresAt, targetDeviceId])
      return code
    } catch (error) {
      const isDuplicate = String((error as any)?.code || '').startsWith('SQLITE_CONSTRAINT')
      if (attempt >= 1 || !isDuplicate) throw error
      console.warn('Pairing code collision, regenerating')
    }
  }
}

/**
 * 만료됐거나 이미 사용된 페어링 코드를 삭제하고 삭제된 행 수를 반환한다.
 */
export const pruneExpiredPairingCodes = async (db: any = getDb()): Promise<number> => {
  const result = await withTransaction(async () => db.run(
    'DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL',
    [new Date().toISOString()],
  ))
  return result.changes ?? 0
}

/**
 * Handles issuing a pairing code.
 * body.deviceId 가 없으면 기기와 무관한(신규 기기용) 코드를 발급한다.
 * body.deviceId 가 있으면 그 기기에 묶인 코드를 발급한다 — 재페어링은 이 코드로만
 * 허용되어, 다른 기기의 코드로 이미 페어링된 기기를 가로챌 수 없다.
 * 관리자 인증이 필요한 라우트에서만 호출된다 (공개 라우트가 아니다).
 */
export const handleCreatePairingCode = async (request: any, reply: any) => {
  const { deviceId } = (request.body || {}) as { deviceId?: number }
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()

  try {
    let targetDeviceId: number | null = null
    if (deviceId !== undefined && deviceId !== null) {
      if (!Number.isInteger(deviceId) || deviceId <= 0) {
        reply.code(400).send({ message: 'Invalid deviceId' })
        return
      }
      const device = await getDb().get('SELECT id FROM devices WHERE id = ?', [deviceId])
      if (!device) {
        reply.code(404).send({ message: 'Device not found' })
        return
      }
      targetDeviceId = device.id
    }

    const code = await withTransaction((tx) => insertPairingCode(tx, expiresAt, targetDeviceId))
    reply.code(201).send({ code, expiresAt })
  } catch (error) {
    console.error('Error creating pairing code:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}
