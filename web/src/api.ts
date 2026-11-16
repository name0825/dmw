import type { AlertItem, Device, DeviceHistoryEntry } from './types'

export const getApiBaseUrl = () => (
  import.meta.env.VITE_API_BASE || '/api'
).replace(/\/$/, '')

export const getWebSocketBaseUrl = () => (
  import.meta.env.VITE_WS_BASE ||
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
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

let refreshPromise: Promise<string | null> | null = null

/**
 * Execute an authenticated JSON fetch, retrying once after a refresh when the
 * server responds with 401. Concurrent 401s share a single in-flight refresh.
 * @param {string} url - Request URL.
 * @param {RequestInit} init - Fetch options (Authorization header is added automatically).
 * @param {string} token - Current access token.
 * @param {() => Promise<string | null>} refresh - Refreshes the session, returning the new token or null.
 * @returns {{ res: Response; data: any }} Response and parsed JSON payload from the final attempt.
 */
export const authorizedRequest = async (
  url: string,
  init: RequestInit,
  token: string,
  refresh: () => Promise<string | null>,
) => {
  const attempt = (authToken: string) => requestJson(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${authToken}` },
  })

  const first = await attempt(token)
  if (first.res.status !== 401) return first

  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => {
      refreshPromise = null
    })
  }

  const newToken = await refreshPromise
  if (!newToken) return first

  return attempt(newToken)
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
export const normalizeAlerts = (alerts: (AlertItem & { created_at?: string })[] = []) => alerts.map((alert) => ({
  ...alert,
  value: Number(alert.value ?? 0),
  createdAt: alert.createdAt ?? alert.created_at,
}))
