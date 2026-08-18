/**
 * 알림 서비스 - Discord/Slack 웹훅을 통한 알림 전송
 */

import type { Database } from 'sqlite'
import type { DeviceAlert } from '../alerts.js'

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
    })
  } catch (error) {
    // 웹훅 실패는 주 모니터링 흐름을 방해하지 않도록 조용히 처리
    console.error('[Notifications] Failed to send alert:', error)
  }
}

/**
 * 알림 기록을 DB 에 저장하는 헬퍼 함수.
 *
 * @param db - SQLite DB 인스턴스
 * @param alerts - 저장할 알림 목록
 */
export const saveAlertsToDb = async (
  db: Database,
  alerts: DeviceAlert[]
): Promise<void> => {
  // TODO: 알림 테이블 생성 및 저장 로직 구현
}
