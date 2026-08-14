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
  const cpuThreshold = getThreshold('ALERT_CPU_THRESHOLD', 85)
  const memoryThreshold = getThreshold('ALERT_MEMORY_THRESHOLD', 80)
  const diskThreshold = getThreshold('ALERT_DISK_THRESHOLD', 90)

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

export async function notifyAlerts(alerts: DeviceAlert[]) {
  if (!alerts.length) return

  const discordWebhook = process.env.DISCORD_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL
  if (!discordWebhook) return

  const message = alerts
    .map((alert) => `${alert.metric.toUpperCase()} ${alert.value}% · ${alert.message}`)
    .join('\n')

  try {
    const payload = discordWebhook.includes('discord')
      ? {
          username: 'DMW Alert',
          embeds: [{
            title: 'Device monitoring alert',
            description: message,
            color: 15158332,
          }],
        }
      : {
          text: `DMW Alert\n${message}`,
        }

    await fetch(discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // webhook failures should not break the main monitoring flow
  }
}
