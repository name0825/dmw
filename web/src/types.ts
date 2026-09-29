type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'NOT_PAIRED' | 'WAKE_TIMEOUT' | string

export type Device = {
  id: number
  name: string
  mac_address: string
  ip_address: string
  status: DeviceStatus
  agent_paired: boolean
  last_seen?: string
  agent_version?: string | null
  ssh_username?: string | null
  ssh_port?: number | null
  ssh_host_key?: string | null
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

export type SshRunResult = {
  runId: number
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

export type CommandRun = {
  id: number
  command: string
  exitCode: number | null
  signal: string | null
  truncated: boolean
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export type PairingInfo = {
  code: string
  expiresAt: string
  targetDeviceName?: string
}
