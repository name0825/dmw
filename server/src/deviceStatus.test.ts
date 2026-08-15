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
  // Test with old last_seen but recent updated_at (simulating WOL packet sent)
  const pending = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp
    updated_at: '2026-08-14T12:00:00.000Z', // Recent timestamp (WOL sent)
  }, pendingNow)

  assert.equal(pending, 'WAKE_TIMEOUT')

  const timeoutNow = new Date('2026-08-14T12:03:00.000Z')
  // Test with old last_seen but recent updated_at (simulating WOL packet sent)
  const timedOut = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp
    updated_at: '2026-08-14T12:00:00.000Z', // Recent timestamp (WOL sent)
  }, timeoutNow)

  assert.equal(timedOut, 'OFFLINE')
})

test('WAKE_TIMEOUT with old updated_at becomes OFFLINE immediately', () => {
  const now = new Date('2026-08-14T12:00:00.000Z')
  // Test with old last_seen and old updated_at (simulating device that was offline for a while)
  const result = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp
    updated_at: '2026-08-14T11:58:00.000Z', // Even older timestamp (device was offline)
  }, now)

  assert.equal(result, 'OFFLINE')
})
