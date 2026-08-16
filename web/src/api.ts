import type { AlertItem, Device, DeviceHistoryEntry } from './types'

export const getApiBaseUrl = () => (import.meta.env.VITE_API_BASE || 'http://localhost:3001').replace(/\/$/, '')

export const getWebSocketBaseUrl = () => (
  import.meta.env.VITE_WS_BASE ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
).replace(/\/$/, '')

/**
 * Execute a JSON fetch and normalize the response payload.
 * @param {string} url - Request URL.
 * @param {RequestInit} init - Fetch options.
 * @returns {{ res: Response; data: any }} Response and parsed JSON payload.
 */
export const requestJson = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, init)
  let data: any = null

  try {
    data = await res.json()
  } catch {
    data = null
  }

  return { res, data }
}

/**
 * Normalize device payloads from the API to numeric metrics.
 * @param {Array<Device>} devices - Raw device records.
 * @returns {Array<Device>} Converted device list.
 */
export const normalizeDevices = (devices: Device[]) => devices.map((device) => ({
  ...device,
  cpu_usage: Number(device.cpu_usage ?? 0),
  memory_usage: Number(device.memory_usage ?? 0),
  disk_usage: Number(device.disk_usage ?? 0),
}))

/**
 * Build the last known history map from the API response.
 * @param {Record<number, DeviceHistoryEntry[]>} existing - Previous map.
 * @param {number} deviceId - Device identifier.
 * @param {DeviceHistoryEntry[]} history - New history entries.
 * @returns {Record<number, DeviceHistoryEntry[]>} Updated map.
 */
export const mapHistory = (
  existing: Record<number, DeviceHistoryEntry[]>,
  deviceId: number,
  history: DeviceHistoryEntry[] = [],
) => ({
  ...existing,
  [deviceId]: history,
})

/**
 * Keep alert rows together with the server metadata used by the UI.
 * @param {AlertItem[]} alerts - Alert list from the API.
 * @returns {AlertItem[]} Normalized alert list.
 */
export const normalizeAlerts = (alerts: AlertItem[] = []) => alerts.map((alert) => ({
  ...alert,
  value: Number(alert.value ?? 0),
}))
