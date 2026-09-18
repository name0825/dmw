import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// ============================================================================
// Configuration module for DMW server
// Environment variables take precedence over defaults
// ============================================================================

dotenv.config()

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(moduleDir, '..', '..')
dotenv.config({ path: process.env.DMW_CONFIG || path.join(repoRoot, 'dmw.conf') })

const DEFAULT_PORT = 3001

/**
 * Normalize a comma-separated list into an array of trimmed, non-empty strings.
 * Accepts values from CORS_ORIGIN or FRONTEND_ORIGIN environment variables.
 * @param value - Comma-separated string (optional)
 * @returns Array of trimmed, non-empty strings
 */
const normalizeList = (value?: string): string[] =>
  (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

/**
 * Application environment mode. Defaults to 'development' if NODE_ENV is not set.
 */
export const APP_ENV = process.env.NODE_ENV || 'development'

/**
 * Server port number. PORT (alias for SERVER_PORT) takes precedence, then
 * SERVER_PORT from the environment or dmw.conf, then the built-in default.
 */
export const PORT = Number(process.env.PORT || process.env.SERVER_PORT || DEFAULT_PORT)

export const WS_PORT = Number(process.env.WS_PORT || PORT + 1)

export const WEB_DEV_PORT = Number(process.env.WEB_DEV_PORT || 5173)

/**
 * Host address the HTTP and WebSocket servers bind to.
 * Defaults to '0.0.0.0'. Set to '127.0.0.1' when running under Docker with
 * network_mode: host, so the server is only reachable via the host loopback.
 */
export const BIND_HOST = process.env.BIND_HOST || '0.0.0.0'

/**
 * JWT secret key for token signing.
 * Must be configured via JWT_SECRET environment variable in production.
 * Defaults to 'dev-secret' in non-production environments.
 */
export const JWT_SECRET = process.env.JWT_SECRET || (APP_ENV === 'production' ? '' : 'dev-secret')

/**
 * Path to the SQLite database file. Defaults to 'data/dmw.db' relative to cwd.
 */
export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'dmw.db')

/**
 * Admin account email. Defaults to 'admin@dmw.local' if ADMIN_EMAIL is not set.
 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dmw.local'

/**
 * Admin account password. Must be set via ADMIN_PASSWORD in production.
 * Defaults to 'admin123' in non-production environments.
 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (APP_ENV === 'production' ? '' : 'admin123')

/**
 * List of allowed CORS origins from environment variables.
 */
export const CORS_ORIGIN = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)

/**
 * Secure flag for refresh-token cookie.
 * Defaults to true in production to prevent token transmission over plain HTTP.
 * Override with COOKIE_SECURE=false only for local HTTP development.
 */
const cookieSecureRaw = process.env.COOKIE_SECURE
export const COOKIE_SECURE =
  cookieSecureRaw !== undefined
    ? cookieSecureRaw === 'true'
    : APP_ENV === 'production'

/**
 * Explicit broadcast address for Wake-on-LAN packets.
 * When unset, the address is derived from the target device IP assuming a /24
 * subnet, which is the common home-LAN case. Set this when the LAN uses a
 * different prefix, since a wrong broadcast address makes WOL fail silently.
 */
export const WOL_BROADCAST_ADDRESS = process.env.WOL_BROADCAST_ADDRESS || ''

/**
 * Validates runtime configuration and throws errors for insecure production settings.
 * Ensures JWT_SECRET and ADMIN_PASSWORD are properly configured when running in production.
 * Safe to skip in development or test environments.
 * @throws {Error} If JWT_SECRET or ADMIN_PASSWORD is not properly configured in production
 */
/** JWT_SECRET placeholder values used in server/.env.example and server/.env.production.example. */
const PLACEHOLDER_JWT_SECRETS = ['dev-secret', 'change-me-in-production', 'replace-with-long-random-secret']

/** ADMIN_PASSWORD placeholder values used in server/.env.example and server/.env.production.example. */
const PLACEHOLDER_ADMIN_PASSWORDS = ['admin123', 'replace-with-strong-password']

/** Minimum acceptable JWT_SECRET length in production. */
const MIN_JWT_SECRET_LENGTH = 32

export const validateRuntimeConfig = (): void => {
  const runtimeEnv = (process.env.NODE_ENV || APP_ENV).trim().toLowerCase()

  if (runtimeEnv !== 'production') {
    return
  }

  const runtimeJwtSecret = (process.env.JWT_SECRET || JWT_SECRET).trim()
  const runtimeAdminPassword = (process.env.ADMIN_PASSWORD || ADMIN_PASSWORD).trim()

  if (!runtimeJwtSecret || PLACEHOLDER_JWT_SECRETS.includes(runtimeJwtSecret)) {
    throw new Error('JWT_SECRET must be set in production mode.')
  }

  if (runtimeJwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production mode.`)
  }

  if (!runtimeAdminPassword || PLACEHOLDER_ADMIN_PASSWORDS.includes(runtimeAdminPassword)) {
    throw new Error('ADMIN_PASSWORD must be set in production mode.')
  }

  const runtimeCorsOrigin = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)

  if (runtimeCorsOrigin.length === 0) {
    throw new Error(
      'CORS_ORIGIN must be set in production mode (e.g. CORS_ORIGIN=https://example.com,https://app.example.com).'
    )
  }
}
