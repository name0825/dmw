type DeviceStatusInput = {
  status?: string
  last_seen?: string | null
  updated_at?: string | null
}

const MS_PER_SECOND = 1000
const OFFLINE_AFTER_MS = 30 * MS_PER_SECOND
const WAKE_TIMEOUT_AFTER_MS = 3 * 60 * MS_PER_SECOND

// new Date('').getTime() and new Date('garbage').getTime() are both NaN, so any
// timestamp field must be run through this before arithmetic to avoid comparisons
// that are always false.
const parseTimestamp = (raw?: string | null): number | null => {
  if (!raw) return null
  const time = new Date(raw).getTime()
  return Number.isNaN(time) ? null : time
}

export function evaluateDeviceStatus(device: DeviceStatusInput, now: Date = new Date()) {
  const status = device.status || 'NOT_PAIRED'

  if (status === 'WAKE_TIMEOUT') {
    // For WAKE_TIMEOUT, we should use updated_at (when the WOL packet was sent) instead of last_seen
    // to properly calculate the timeout period. If updated_at is missing/unparseable, fall back to
    // last_seen, and if neither yields a usable timestamp there is no way to measure the wake
    // window, so resolve to OFFLINE instead of staying in WAKE_TIMEOUT forever.
    const wakeSentAt = parseTimestamp(device.updated_at) ?? parseTimestamp(device.last_seen)
    if (wakeSentAt === null) {
      return 'OFFLINE'
    }
    const elapsedFromWake = now.getTime() - wakeSentAt
    return elapsedFromWake > WAKE_TIMEOUT_AFTER_MS ? 'OFFLINE' : 'WAKE_TIMEOUT'
  }

  const lastSeen = parseTimestamp(device.last_seen) ?? parseTimestamp(device.updated_at)
  if (lastSeen === null) {
    return status
  }

  const elapsed = now.getTime() - lastSeen

  if (status === 'ONLINE' && elapsed > OFFLINE_AFTER_MS) {
    return 'OFFLINE'
  }

  return status
}
