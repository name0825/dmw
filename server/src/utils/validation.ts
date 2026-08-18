/**
 * 입력 검증 유틸리티 함수 모음
 */

/**
 * MAC 주소를 정규화하는 함수.
 * 콜론 구분 (AA:BB:CC:DD:EE:FF), 대시 구분 (aa-bb-cc-dd-ee-ff), 또는 순수 16 자리 16진수 형식을 모두 인식.
 * 유효하지 않으면 null 을 반환.
 *
 * @param raw - 원문 MAC 주소
 * @returns 정규화된 MAC 주소 (AA:BB:CC:DD:EE:FF 형식) 또는 null
 */
export const normalizeMac = (raw: string): string | null => {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  let hex: string
  // 콜론 구분 형식
  const MAC_COLON_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
  // 대시 구분 형식
  const MAC_DASH_RE = /^(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/
  // 순수 16 자리 형식
  const MAC_PLAIN_RE = /^[0-9A-Fa-f]{12}$/

  if (MAC_COLON_RE.test(trimmed) || MAC_DASH_RE.test(trimmed)) {
    hex = trimmed.replace(/[:-]/g, '')
  } else if (MAC_PLAIN_RE.test(trimmed)) {
    hex = trimmed
  } else {
    return null
  }

  if (hex.length !== 12) return null

  const grouped = hex.toUpperCase().match(/.{2}/g)
  if (!grouped) return null
  return grouped.join(':')
}

/**
 * MAC 주소 유효성 검사.
 *
 * @param raw - 원문 MAC 주소
 * @returns 유효하면 true, 아니면 false
 */
export const isValidMac = (raw: string): boolean => normalizeMac(raw) !== null

/**
 * IPv4 주소를 정규화하는 함수.
 * 유효하지 않으면 null 을 반환.
 *
 * @param raw - 원문 IP 주소
 * @returns 정규화된 IP 주소 또는 null
 */
export const normalizeIp = (raw: string): string | null => {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  // IPv4 정규식 (각 옥텟 0-255)
  const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

  if (!IPV4_RE.test(trimmed)) return null
  return trimmed
}

/**
 * IPv4 주소 유효성 검사.
 *
 * @param raw - 원문 IP 주소
 * @returns 유효하면 true, 아니면 false
 */
export const isValidIp = (raw: string): boolean => normalizeIp(raw) !== null

/**
 * Validates a usage value is a number between 0 and 100
 * @param value - The value to validate
 * @returns The validated number, or null if invalid
 */
export const normalizeUsage = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}
