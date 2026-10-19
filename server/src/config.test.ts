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
    process.env.JWT_SECRET = 'a-real-production-secret-that-is-long-enough'
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

test('production rejects example placeholder secrets and short JWT_SECRET', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousJwtSecret = process.env.JWT_SECRET
  const previousAdminPassword = process.env.ADMIN_PASSWORD
  const previousCorsOrigin = process.env.CORS_ORIGIN

  try {
    process.env.NODE_ENV = 'production'
    process.env.CORS_ORIGIN = 'https://example.com'
    process.env.ADMIN_PASSWORD = 'a-real-production-password'

    process.env.JWT_SECRET = 'change-me-in-production'
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.JWT_SECRET = 'replace-with-long-random-secret'
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.JWT_SECRET = 'too-short-secret'
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET must be at least 32 characters/)

    process.env.JWT_SECRET = 'a-real-production-secret-that-is-long-enough'

    process.env.ADMIN_PASSWORD = 'admin123'
    assert.throws(() => validateRuntimeConfig(), /ADMIN_PASSWORD/)

    process.env.ADMIN_PASSWORD = 'replace-with-strong-password'
    assert.throws(() => validateRuntimeConfig(), /ADMIN_PASSWORD/)

    process.env.ADMIN_PASSWORD = 'a-real-production-password'
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
  }
})

test('production check is case-insensitive on NODE_ENV and rejects whitespace-padded placeholders', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousJwtSecret = process.env.JWT_SECRET
  const previousAdminPassword = process.env.ADMIN_PASSWORD
  const previousCorsOrigin = process.env.CORS_ORIGIN

  try {
    process.env.NODE_ENV = 'Production'
    process.env.CORS_ORIGIN = 'https://example.com'
    process.env.ADMIN_PASSWORD = 'a-real-production-password'

    process.env.JWT_SECRET = '  change-me-in-production  '
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.JWT_SECRET = '   '
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.JWT_SECRET = 'a-real-production-secret-that-is-long-enough'
    process.env.ADMIN_PASSWORD = '  admin123  '
    assert.throws(() => validateRuntimeConfig(), /ADMIN_PASSWORD/)

    process.env.ADMIN_PASSWORD = 'a-real-production-password'
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
  }
})

test('unset or unknown NODE_ENV fails closed: placeholder secrets are rejected, only development/test skip checks', () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  }

  try {
    delete process.env.NODE_ENV
    delete process.env.JWT_SECRET
    delete process.env.ADMIN_PASSWORD
    delete process.env.CORS_ORIGIN
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.NODE_ENV = 'staging'
    assert.throws(() => validateRuntimeConfig(), /JWT_SECRET/)

    process.env.NODE_ENV = 'development'
    assert.doesNotThrow(() => validateRuntimeConfig())
    process.env.NODE_ENV = ' Test '
    assert.doesNotThrow(() => validateRuntimeConfig())

    delete process.env.NODE_ENV
    process.env.JWT_SECRET = 'a-real-production-secret-that-is-long-enough'
    process.env.ADMIN_PASSWORD = 'a-real-production-password'
    process.env.CORS_ORIGIN = 'https://example.com'
    assert.doesNotThrow(() => validateRuntimeConfig())
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('production requires ADMIN_PASSWORD of at least 12 characters', () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  }

  try {
    process.env.NODE_ENV = 'production'
    process.env.JWT_SECRET = 'a-real-production-secret-that-is-long-enough'
    process.env.CORS_ORIGIN = 'https://example.com'

    process.env.ADMIN_PASSWORD = 'short-pass1'
    assert.throws(() => validateRuntimeConfig(), /ADMIN_PASSWORD must be at least 12/)

    process.env.ADMIN_PASSWORD = 'twelve-chars'
    assert.doesNotThrow(() => validateRuntimeConfig())
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
