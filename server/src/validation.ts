// Input validation helpers for device registration / update.
// Kept framework-agnostic so they can be unit-tested and reused across routes.

const MAC_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
const MAC_DASH_RE = /^(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/
const MAC_PLAIN_RE = /^[0-9A-Fa-f]{12}$/

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * Normalize a MAC address to canonical `AA:BB:CC:DD:EE:FF` (uppercase, colon-separated).
 * Accepts colon, dash, or plain hex separators. Returns null if invalid.
 */
export const normalizeMac = (raw: string): string | null => {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  let hex: string
  if (MAC_RE.test(trimmed) || MAC_DASH_RE.test(trimmed)) {
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

export const isValidMac = (raw: string): boolean => normalizeMac(raw) !== null

/**
 * Validate an IPv4 address (dotted quad, each octet 0-255).
 * Returns the trimmed value if valid, otherwise null.
 */
export const normalizeIp = (raw: string): string | null => {
  const trimmed = (raw || '').trim()
  if (!IPV4_RE.test(trimmed)) return null
  return trimmed
}

export const isValidIp = (raw: string): boolean => normalizeIp(raw) !== null
