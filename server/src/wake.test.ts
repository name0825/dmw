import test from 'node:test'
import assert from 'node:assert/strict'

import { subnetBroadcast, resolveBroadcastAddress, sendWakePacket } from './services/wake.js'

const mockInterface = (address: string, netmask: string) => ({
  eth0: [{ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null }],
}) as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>

test('subnetBroadcast falls back to the /24-derived address when no local interface matches the target subnet', () => {
  assert.equal(subnetBroadcast('192.168.0.20', {}), '192.168.0.255')
  assert.equal(subnetBroadcast('10.0.5.37', {}), '10.0.5.255')
})

test('subnetBroadcast derives the broadcast address from the matching interface netmask for /24, /16 and /23 subnets', () => {
  assert.equal(subnetBroadcast('192.168.0.20', mockInterface('192.168.0.20', '255.255.255.0')), '192.168.0.255')
  assert.equal(subnetBroadcast('10.0.5.37', mockInterface('10.0.5.37', '255.255.0.0')), '10.0.255.255')
  assert.equal(subnetBroadcast('10.0.5.37', mockInterface('10.0.4.37', '255.255.254.0')), '10.0.5.255')
})

test('subnetBroadcast warns and falls back to /24 when local interfaces exist but none matches the target subnet', () => {
  const originalWarn = console.warn
  let warned = false
  console.warn = () => { warned = true }
  try {
    assert.equal(
      subnetBroadcast('172.16.5.5', mockInterface('192.168.0.20', '255.255.255.0')),
      '172.16.5.255'
    )
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warned, true)
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

test('subnetBroadcast picks the matching interface with the longest prefix', () => {
  const info = (address: string, netmask: string) => ({ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null })
  const interfaces = {
    wide: [info('10.0.0.1', '255.0.0.0')],
    narrow: [info('10.0.5.1', '255.255.255.0')],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>

  assert.equal(subnetBroadcast('10.0.5.37', interfaces), '10.0.5.255')
})
