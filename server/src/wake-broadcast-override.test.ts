import test from 'node:test'
import assert from 'node:assert/strict'

process.env.WOL_BROADCAST_ADDRESS = '10.0.0.255'

const { resolveBroadcastAddress } = await import('./services/wake.js')

test('resolveBroadcastAddress uses WOL_BROADCAST_ADDRESS when set, ignoring the target IP subnet', () => {
  assert.equal(resolveBroadcastAddress('192.168.0.20'), '10.0.0.255')
  assert.equal(resolveBroadcastAddress('172.16.5.5'), '10.0.0.255')
})
