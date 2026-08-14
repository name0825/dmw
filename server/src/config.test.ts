import test from 'node:test'
import assert from 'node:assert/strict'

import { validateRuntimeConfig } from './config.js'

test('production requires non-default secrets', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousJwtSecret = process.env.JWT_SECRET
  const previousAdminPassword = process.env.ADMIN_PASSWORD

  try {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = ''
    process.env.ADMIN_PASSWORD = 'admin123'

    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv

    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousJwtSecret

    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = previousAdminPassword
  }
})
