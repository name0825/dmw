/**
 * 알림 서비스 - Discord/Slack 웹훅을 통한 알림 전송
 */

import type { DeviceAlert } from '../alerts.js'
import { withTransaction } from '../database/index.js'

/**
 * 알림 전송 실행 함수.
 *
 * @param alerts - 전송할 알림 목록
 * @returns 전송 결과
 */
export const notifyAlerts = async (alerts: DeviceAlert[]): Promise<void> => {
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
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    // 웹훅 실패는 주 모니터링 흐름을 방해하지 않도록 조용히 처리
    console.error('[Notifications] Failed to send alert:', error)
  }
}

/**
 * 알림 기록을 DB 에 저장하는 헬퍼 함수.
 *
 * BEGIN/COMMIT/ROLLBACK 은 withTransaction 이 공유 커넥션에서 직렬화해 처리한다.
 *
 * @param alerts - 저장할 알림 목록
 */
export const saveAlertsToDb = async (
  alerts: DeviceAlert[]
): Promise<void> => {
  if (!alerts.length) return

  try {
    await withTransaction(async (tx) => {
      for (const alert of alerts) {
        await tx.run(
          'INSERT INTO alerts (device_id, level, metric, value, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [alert.deviceId, alert.level, alert.metric, alert.value, alert.message, alert.createdAt]
        )
      }
    })
  } catch (error) {
    console.error('[Notifications] Failed to save alerts:', error)
  }
}
