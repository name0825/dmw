export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'NOT_PAIRED' | 'WAKE_TIMEOUT' | string

export type Device = {
  id: number
  name: string
  mac_address: string
  ip_address: string
  status: DeviceStatus
  agent_paired: boolean
  last_seen?: string
  cpu_usage?: number
  memory_usage?: number
  disk_usage?: number
}

export type DeviceForm = {
  name: string
  mac_address: string
  ip_address: string
}

export type DeviceHistoryEntry = {
  timestamp: string
  cpu_usage: number
  memory_usage: number
  disk_usage: number
}

export type AlertItem = {
  deviceId: number
  level: 'info' | 'warning' | 'critical' | string
  message: string
  metric: string
  value: number
}

export type PairingInfo = {
  code: string
  expiresAt: string
}
