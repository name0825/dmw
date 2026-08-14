import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateDeviceStatus } from './deviceStatus.js'

test('ONLINE device becomes OFFLINE after 30 seconds without heartbeat', () => {
  const now = new Date('2026-08-14T12:00:00.000Z')
  const result = evaluateDeviceStatus({
    status: 'ONLINE',
    last_seen: '2026-08-14T11:59:29.000Z',
    updated_at: '2026-08-14T11:59:29.000Z',
  }, now)

  assert.equal(result, 'OFFLINE')
})

test('WAKE_TIMEOUT remains pending until three minutes pass', () => {
  const pendingNow = new Date('2026-08-14T12:00:00.000Z')
  const pending = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z',
    updated_at: '2026-08-14T11:59:00.000Z',
  }, pendingNow)

  assert.equal(pending, 'WAKE_TIMEOUT')

  const timeoutNow = new Date('2026-08-14T12:03:00.000Z')
  const timedOut = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z',
    updated_at: '2026-08-14T11:59:00.000Z',
  }, timeoutNow)

  assert.equal(timedOut, 'OFFLINE')
})
