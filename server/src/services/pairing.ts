/**
 * Pairing code service.
 * 페어링 코드는 기기와 무관하게 발급된다. 코드에 기기가 묶이는 시점은
 * 에이전트가 코드를 소진하는 순간(services/agent.ts 의 handlePair)이다.
 */

import { randomBytes } from 'node:crypto'

import { PAIRING_TTL_MS } from '../config/constants.js'
import { getDb } from '../database/index.js'

/**
 * Inserts a fresh pairing code and returns it.
 * The code is only 32 bits of randomness and pairing_codes(code) is UNIQUE, so a
 * collision is possible; retry exactly once rather than surfacing a raw 500.
 * A second collision is astronomically unlikely and is left to the caller's 500
 * handler — retrying in a loop would only hide a real constraint problem.
 */
export const insertPairingCode = async (db: any, expiresAt: string): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    const code = randomBytes(4).toString('hex').toUpperCase()
    try {
      await db.run('INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)', [code, expiresAt])
      return code
    } catch (error) {
      const isDuplicate = String((error as any)?.code || '').startsWith('SQLITE_CONSTRAINT')
      if (attempt >= 1 || !isDuplicate) throw error
      console.warn('Pairing code collision, regenerating')
    }
  }
}

/**
 * Handles issuing a device-independent one-time pairing code.
 * 관리자 인증이 필요한 라우트에서만 호출된다 (공개 라우트가 아니다).
 */
export const handleCreatePairingCode = async (request: any, reply: any) => {
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()

  try {
    const code = await insertPairingCode(getDb(), expiresAt)
    reply.code(201).send({ code, expiresAt })
  } catch (error) {
    console.error('Error creating pairing code:', error)
    reply.code(500).send({ message: 'Internal server error' })
  }
}
