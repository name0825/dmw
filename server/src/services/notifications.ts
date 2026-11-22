/**
 * 알림 서비스 - Discord/Slack 웹훅과 Telegram을 통한 알림 전송
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

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
  const telegramChatId = process.env.TELEGRAM_CHAT_ID
  if (!webhookUrl && !(telegramBotToken && telegramChatId)) return

  const message = alerts
    .map((alert) => `[${alert.deviceName ?? `#${alert.deviceId}`}] ${alert.metric === 'offline' ? 'OFFLINE' : `${alert.metric.toUpperCase()} ${alert.value}%`} · ${alert.message}`)
    .join('\n')

  const deliveries: Promise<void>[] = []

  if (webhookUrl) {
    const payload = webhookUrl.includes('discord')
      ? {
          username: 'DMW Alert',
          embeds: [{
            title: 'Device monitoring alert',
            description: message.slice(0, 4096),
            color: 15158332,
          }],
        }
      : {
          text: `DMW Alert\n${message}`,
        }

    deliveries.push(sendNotification(webhookUrl, payload))
  }

  if (telegramBotToken && telegramChatId) {
    deliveries.push(sendNotification(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      { chat_id: telegramChatId, text: `DMW Alert\n${message}`.slice(0, 4096) },
    ))
  }

  await Promise.all(deliveries)
}

const sendNotification = async (url: string, payload: object): Promise<void> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      console.error(`[Notifications] Failed to send alert: HTTP ${response.status}`)
    }
  } catch (error) {
    console.error(`[Notifications] Failed to send alert: ${error instanceof Error ? error.name : 'unknown error'}`)
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
