/**
 * 암호화 관련 헬퍼 함수 모음
 */

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

/**
 * 리프레시 토큰의 16자 접두 (lookup_id)를 추출한다.
 * 토큰의 첫 16자를 소문자로 변환하여 반환한다.
 * @param {string} refreshToken - 리프레시 토큰 원문
 * @returns {string} 16자 lookup_id
 */
export const getRefreshLookupId = (refreshToken: string): string => {
  return (refreshToken.slice(0, 16).toLowerCase() || '').trim()
}

/**
 * 임의의 32바이트 hex 문자열을 생성한다.
 * @returns {string} 32자 hex 문자열
 */
export const generateRandomHex = (): string => {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * 임의의 24바이트 hex 문자열을 생성한다.
 * @returns {string} 24자 hex 문자열
 */
export const generateApiKey = (): string => {
  return crypto.randomBytes(24).toString('hex')
}
