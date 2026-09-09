/**
 * 암호화 관련 헬퍼 함수 모음
 */

import crypto from 'node:crypto'

/**
 * 임의의 24바이트 hex 문자열을 생성한다.
 * @returns {string} 24자 hex 문자열
 */
export const generateApiKey = (): string => {
  return crypto.randomBytes(24).toString('hex')
}
