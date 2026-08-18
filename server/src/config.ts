import 'dotenv/config'
import path from 'node:path'

// ============================================================================
// Configuration module for DMW server
// Environment variables take precedence over defaults
// ============================================================================

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
 * Server port number. Defaults to 3001 if PORT is not set.
 */
export const PORT = Number(process.env.PORT || DEFAULT_PORT)

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
 * Validates runtime configuration and throws errors for insecure production settings.
 * Ensures JWT_SECRET and ADMIN_PASSWORD are properly configured when running in production.
 * Safe to skip in development or test environments.
 * @throws {Error} If JWT_SECRET or ADMIN_PASSWORD is not properly configured in production
 */
export const validateRuntimeConfig = (): void => {
  const runtimeEnv = process.env.NODE_ENV || APP_ENV

  if (runtimeEnv !== 'production') {
    return
  }

  const runtimeJwtSecret = process.env.JWT_SECRET || JWT_SECRET
  const runtimeAdminPassword = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD

  if (!runtimeJwtSecret || runtimeJwtSecret === 'dev-secret' || runtimeJwtSecret === 'change-me-in-production') {
    throw new Error('JWT_SECRET must be set in production mode.')
  }

  if (!runtimeAdminPassword || runtimeAdminPassword === 'admin123') {
    throw new Error('ADMIN_PASSWORD must be set in production mode.')
  }
}
