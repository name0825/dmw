type DeviceStatusInput = {
  status?: string
  last_seen?: string | null
  updated_at?: string | null
}

const MS_PER_SECOND = 1000
const OFFLINE_AFTER_MS = 30 * MS_PER_SECOND
const WAKE_TIMEOUT_AFTER_MS = 3 * 60 * MS_PER_SECOND

export function evaluateDeviceStatus(device: DeviceStatusInput, now: Date = new Date()) {
  const status = device.status || 'NOT_PAIRED'
  const lastSeenRaw = device.last_seen || device.updated_at

  if (!lastSeenRaw) {
    return status === 'WAKE_TIMEOUT' ? 'WAKE_TIMEOUT' : status
  }

  const lastSeen = new Date(lastSeenRaw).getTime()
  const elapsed = now.getTime() - lastSeen

  if (status === 'WAKE_TIMEOUT') {
    return elapsed > WAKE_TIMEOUT_AFTER_MS ? 'OFFLINE' : 'WAKE_TIMEOUT'
  }

  if (status === 'ONLINE' && elapsed > OFFLINE_AFTER_MS) {
    return 'OFFLINE'
  }

  return status
}
