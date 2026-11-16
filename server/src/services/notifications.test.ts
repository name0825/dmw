import test from 'node:test'
import assert from 'node:assert/strict'

import { notifyAlerts } from './notifications.js'

test('sends Telegram alerts with the configured bot credentials', async () => {
  const previousFetch = globalThis.fetch
  const previousDiscordWebhook = process.env.DISCORD_WEBHOOK_URL
  const previousSlackWebhook = process.env.SLACK_WEBHOOK_URL
  const previousTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN
  const previousTelegramChatId = process.env.TELEGRAM_CHAT_ID
  const calls: Array<{ input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] }> = []

  try {
    delete process.env.DISCORD_WEBHOOK_URL
    delete process.env.SLACK_WEBHOOK_URL
    process.env.TELEGRAM_BOT_TOKEN = '123456:token'
    process.env.TELEGRAM_CHAT_ID = '-100123'
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      return new Response(null, { status: 200 })
    }

    await notifyAlerts([{
      deviceId: 42,
      deviceName: 'NAS',
      level: 'critical',
      metric: 'offline',
      value: 0,
      message: '디바이스가 오프라인 상태가 되었습니다.',
      createdAt: '2026-09-16T00:00:00.000Z',
    }])

    assert.equal(calls.length, 1)
    assert.equal(calls[0].input, 'https://api.telegram.org/bot123456:token/sendMessage')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      chat_id: '-100123',
      text: 'DMW Alert\n[NAS] OFFLINE · 디바이스가 오프라인 상태가 되었습니다.',
    })
  } finally {
    globalThis.fetch = previousFetch

    if (previousDiscordWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL
    else process.env.DISCORD_WEBHOOK_URL = previousDiscordWebhook

    if (previousSlackWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL
    else process.env.SLACK_WEBHOOK_URL = previousSlackWebhook

    if (previousTelegramBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = previousTelegramBotToken

    if (previousTelegramChatId === undefined) delete process.env.TELEGRAM_CHAT_ID
    else process.env.TELEGRAM_CHAT_ID = previousTelegramChatId
  }
})
