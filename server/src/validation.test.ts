import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMac, isValidMac, normalizeIp, isValidIp, normalizeUsage } from './utils/validation.js'

test('normalizeMac accepts colon, dash, and plain hex formats', () => {
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizeMac('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizeMac('  AA:BB:CC:DD:EE:FF  '), 'AA:BB:CC:DD:EE:FF')
})

test('normalizeMac rejects malformed input', () => {
  assert.equal(normalizeMac(''), null)
  assert.equal(normalizeMac('AA:BB:CC:DD:EE'), null) // too short
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF:00'), null) // too long
  assert.equal(normalizeMac('GG:BB:CC:DD:EE:FF'), null) // non-hex
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:F'), null) // odd hex length
  assert.equal(normalizeMac(null as unknown as string), null)
  assert.equal(normalizeMac(undefined as unknown as string), null)
})

test('isValidMac mirrors normalizeMac validity', () => {
  assert.equal(isValidMac('AA:BB:CC:DD:EE:FF'), true)
  assert.equal(isValidMac('not-a-mac'), false)
})

test('normalizeIp accepts valid IPv4 addresses', () => {
  assert.equal(normalizeIp('192.168.0.1'), '192.168.0.1')
  assert.equal(normalizeIp('0.0.0.0'), '0.0.0.0')
  assert.equal(normalizeIp('255.255.255.255'), '255.255.255.255')
  assert.equal(normalizeIp('  10.0.0.1  '), '10.0.0.1')
})

test('normalizeIp rejects malformed or out-of-range input', () => {
  assert.equal(normalizeIp(''), null)
  assert.equal(normalizeIp('256.1.1.1'), null) // out-of-range octet
  assert.equal(normalizeIp('1.1.1'), null) // too few octets
  assert.equal(normalizeIp('1.1.1.1.1'), null) // too many octets
  assert.equal(normalizeIp('a.b.c.d'), null) // non-numeric
  assert.equal(normalizeIp('::1'), null) // IPv6 unsupported
  assert.equal(normalizeIp(null as unknown as string), null)
  assert.equal(normalizeIp(undefined as unknown as string), null)
})

test('isValidIp mirrors normalizeIp validity', () => {
  assert.equal(isValidIp('192.168.0.1'), true)
  assert.equal(isValidIp('999.1.1.1'), false)
})

test('normalizeUsage accepts numbers in [0, 100]', () => {
  assert.equal(normalizeUsage(0), 0)
  assert.equal(normalizeUsage(100), 100)
  assert.equal(normalizeUsage(42.5), 42.5)
})

test('normalizeUsage rejects out-of-range, non-finite, and non-number values', () => {
  assert.equal(normalizeUsage(-1), null)
  assert.equal(normalizeUsage(101), null)
  assert.equal(normalizeUsage(NaN), null)
  assert.equal(normalizeUsage(Infinity), null)
  assert.equal(normalizeUsage('50'), null)
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage(undefined), null)
})
