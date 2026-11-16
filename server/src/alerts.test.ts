import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateOfflineAlert } from './alerts.js'
import { STATUS_OFFLINE, STATUS_ONLINE } from './config/constants.js'

test('creates one alert when a device becomes offline', () => {
  const alerts = evaluateOfflineAlert({ id: 42, name: 'NAS', status: STATUS_OFFLINE }, STATUS_ONLINE)

  assert.equal(alerts.length, 1)
  assert.deepEqual({
    deviceId: alerts[0].deviceId,
    deviceName: alerts[0].deviceName,
    level: alerts[0].level,
    metric: alerts[0].metric,
    value: alerts[0].value,
    message: alerts[0].message,
  }, {
    deviceId: 42,
    deviceName: 'NAS',
    level: 'critical',
    metric: 'offline',
    value: 0,
    message: '디바이스가 오프라인 상태가 되었습니다.',
  })
})

test('does not create another alert for an already offline device', () => {
  const alerts = evaluateOfflineAlert({ id: 42, status: STATUS_OFFLINE }, STATUS_OFFLINE)

  assert.deepEqual(alerts, [])
})

test('does not create an offline alert when a WAKE_TIMEOUT device goes OFFLINE', () => {
  const alerts = evaluateOfflineAlert({ id: 42, status: STATUS_OFFLINE }, 'WAKE_TIMEOUT')

  assert.deepEqual(alerts, [])
})
