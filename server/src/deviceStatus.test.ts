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
  // WOL was sent at 12:00:00 (updated_at). last_seen is old (device was offline).
  // The 3-minute window is measured from updated_at, not last_seen.
  const pendingNow = new Date('2026-08-14T12:02:00.000Z')
  const pending = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp (device was offline)
    updated_at: '2026-08-14T12:00:00.000Z', // WOL sent 2 minutes ago
  }, pendingNow)

  assert.equal(pending, 'WAKE_TIMEOUT')

  const timeoutNow = new Date('2026-08-14T12:04:00.000Z')
  const timedOut = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp (device was offline)
    updated_at: '2026-08-14T12:00:00.000Z', // WOL sent 4 minutes ago
  }, timeoutNow)

  assert.equal(timedOut, 'OFFLINE')
})

test('WAKE_TIMEOUT with old updated_at becomes OFFLINE', () => {
  // WOL was sent 5 minutes ago (updated_at), well past the 3-minute window.
  const now = new Date('2026-08-14T12:00:00.000Z')
  const result = evaluateDeviceStatus({
    status: 'WAKE_TIMEOUT',
    last_seen: '2026-08-14T11:59:00.000Z', // Old timestamp
    updated_at: '2026-08-14T11:55:00.000Z', // WOL sent 5 minutes ago
  }, now)

  assert.equal(result, 'OFFLINE')
})
