import test from 'node:test'
import assert from 'node:assert/strict'

import { subnetBroadcast, resolveBroadcastAddress, sendWakePacket } from './services/wake.js'

test('subnetBroadcast derives the .255 address for a /24 network', () => {
  assert.equal(subnetBroadcast('192.168.0.20'), '192.168.0.255')
  assert.equal(subnetBroadcast('10.0.5.37'), '10.0.5.255')
})

test('subnetBroadcast assumes a /24 subnet and gives a wrong answer outside that assumption', () => {
  assert.equal(subnetBroadcast('10.0.5.37'), '10.0.5.255')
  assert.notEqual(subnetBroadcast('10.0.5.37'), '10.0.255.255')
})

test('resolveBroadcastAddress falls back to the /24-derived address when WOL_BROADCAST_ADDRESS is unset', () => {
  assert.equal(process.env.WOL_BROADCAST_ADDRESS, undefined)
  assert.equal(resolveBroadcastAddress('192.168.0.20'), '192.168.0.255')
})

test('sendWakePacket propagates failure instead of resolving when the MAC address is malformed', async () => {
  await assert.rejects(
    sendWakePacket('not-a-mac-address', '192.168.0.20'),
    /malformed MAC address/
  )
})
