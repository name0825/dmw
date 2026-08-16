export const MAC_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const DEFAULT_AGENT_STATE = {
  serverUrl: import.meta.env.VITE_API_BASE || 'http://localhost:3001',
  pairingCode: '',
  apiKey: '',
  deviceId: null as number | null,
}
