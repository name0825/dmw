import test from 'node:test'
import assert from 'node:assert/strict'

import { isPublicRoute } from './auth.js'

test('public routes remain accessible even when query parameters are present', () => {
  assert.equal(isPublicRoute('/auth/login?next=/dashboard'), true)
  assert.equal(isPublicRoute('/auth/refresh?token=abc'), true)
  assert.equal(isPublicRoute('/agent/heartbeat?token=xyz'), true)
  assert.equal(isPublicRoute('/agent/unpair?from=agent'), true)
  assert.equal(isPublicRoute('/auth/logout?force=true'), true)
  assert.equal(isPublicRoute('/devices/12?view=full'), false)
})
