import test from 'node:test'
import assert from 'node:assert/strict'

process.env.WOL_BROADCAST_ADDRESS = 'not-an-ip'

const { resolveBroadcastAddress, sendWakePacket } = await import('./services/wake.js')

test('resolveBroadcastAddress throws when WOL_BROADCAST_ADDRESS is not a valid IPv4 address', () => {
  assert.throws(
    () => resolveBroadcastAddress('192.168.0.20'),
    /WOL_BROADCAST_ADDRESS is not a valid IPv4 address/
  )
})

test('sendWakePacket rejects when WOL_BROADCAST_ADDRESS is invalid instead of sending a packet', async () => {
  await assert.rejects(
    sendWakePacket('AA:BB:CC:DD:EE:FF', '192.168.0.20'),
    /WOL_BROADCAST_ADDRESS is not a valid IPv4 address/
  )
})
