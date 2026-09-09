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

test('production requires CORS_ORIGIN (or FRONTEND_ORIGIN alias) to be set', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousJwtSecret = process.env.JWT_SECRET
  const previousAdminPassword = process.env.ADMIN_PASSWORD
  const previousCorsOrigin = process.env.CORS_ORIGIN
  const previousFrontendOrigin = process.env.FRONTEND_ORIGIN

  try {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'a-real-production-secret'
    process.env.ADMIN_PASSWORD = 'a-real-production-password'
    delete process.env.CORS_ORIGIN
    delete process.env.FRONTEND_ORIGIN

    assert.throws(() => validateRuntimeConfig(), /CORS_ORIGIN/)

    process.env.CORS_ORIGIN = 'https://example.com'
    assert.doesNotThrow(() => validateRuntimeConfig())

    delete process.env.CORS_ORIGIN
    process.env.FRONTEND_ORIGIN = 'https://example.com'
    assert.doesNotThrow(() => validateRuntimeConfig())
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv

    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousJwtSecret

    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = previousAdminPassword

    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousCorsOrigin

    if (previousFrontendOrigin === undefined) delete process.env.FRONTEND_ORIGIN
    else process.env.FRONTEND_ORIGIN = previousFrontendOrigin
  }
})
