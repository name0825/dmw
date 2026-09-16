import {
  DEFAULT_ALERT_CPU_THRESHOLD,
  DEFAULT_ALERT_MEMORY_THRESHOLD,
  DEFAULT_ALERT_DISK_THRESHOLD,
  STATUS_OFFLINE,
} from './config/constants.js'

export type AlertLevel = 'info' | 'warning' | 'critical'

export type DeviceAlert = {
  deviceId: number
  level: AlertLevel
  message: string
  metric: string
  value: number
  createdAt: string
}

const getThreshold = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) ? value : fallback
}

export function evaluateAlerts(device: any): DeviceAlert[] {
  const alerts: DeviceAlert[] = []
  const now = new Date().toISOString()
  const cpuThreshold = getThreshold('ALERT_CPU_THRESHOLD', DEFAULT_ALERT_CPU_THRESHOLD)
  const memoryThreshold = getThreshold('ALERT_MEMORY_THRESHOLD', DEFAULT_ALERT_MEMORY_THRESHOLD)
  const diskThreshold = getThreshold('ALERT_DISK_THRESHOLD', DEFAULT_ALERT_DISK_THRESHOLD)

  if (device.cpu_usage !== null && device.cpu_usage !== undefined && device.cpu_usage > cpuThreshold) {
    alerts.push({
      deviceId: Number(device.id),
      level: 'critical',
      message: `CPU 사용량이 ${cpuThreshold}%를 초과했습니다.`,
      metric: 'cpu',
      value: Number(device.cpu_usage),
      createdAt: now,
    })
  }

  if (device.memory_usage !== null && device.memory_usage !== undefined && device.memory_usage > memoryThreshold) {
    alerts.push({
      deviceId: Number(device.id),
      level: 'warning',
      message: `메모리 사용량이 ${memoryThreshold}%를 초과했습니다.`,
      metric: 'memory',
      value: Number(device.memory_usage),
      createdAt: now,
    })
  }

  if (device.disk_usage !== null && device.disk_usage !== undefined && device.disk_usage > diskThreshold) {
    alerts.push({
      deviceId: Number(device.id),
      level: 'warning',
      message: `디스크 사용량이 ${diskThreshold}%를 초과했습니다.`,
      metric: 'disk',
      value: Number(device.disk_usage),
      createdAt: now,
    })
  }

  return alerts
}

export function evaluateOfflineAlert(device: any, previousStatus: string): DeviceAlert[] {
  if (previousStatus === STATUS_OFFLINE || device.status !== STATUS_OFFLINE) return []

  return [{
    deviceId: Number(device.id),
    level: 'critical',
    message: '디바이스가 오프라인 상태가 되었습니다.',
    metric: 'offline',
    value: 0,
    createdAt: new Date().toISOString(),
  }]
}
