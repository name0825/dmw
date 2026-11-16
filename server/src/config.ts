import fs from 'node:fs'
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

const normalizedNodeEnv = (): string => (process.env.NODE_ENV || '').trim().toLowerCase()

/**
 * True only when NODE_ENV is explicitly 'development' or 'test'. Placeholder
 * secrets and skipped production checks are allowed in these modes only.
 */
const allowsDevDefaults = (): boolean => ['development', 'test'].includes(normalizedNodeEnv())

/**
 * True for every NODE_ENV except 'development' and 'test' (including unset, 'prod',
 * 'staging'). Use this, never `APP_ENV === 'production'`, to gate dev-only relaxations.
 */
export const isProductionLike = (): boolean => !allowsDevDefaults()

/**
 * Application environment mode. Fails closed: an unset NODE_ENV is treated as
 * 'production' so a bare `npm start` never falls back to dev defaults.
 */
export const APP_ENV = normalizedNodeEnv() || 'production'

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
 * Must be configured via JWT_SECRET unless NODE_ENV is explicitly 'development' or 'test',
 * where it defaults to 'dev-secret'.
 */
export const JWT_SECRET = process.env.JWT_SECRET || (allowsDevDefaults() ? 'dev-secret' : '')

/**
 * Path to the SQLite database file. Defaults to 'data/dmw.db' relative to cwd.
 */
export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'dmw.db')

/**
 * Path to the server's SSH private key used for remote command execution.
 * Generated on first use. Defaults to an 'ssh' directory next to the database file.
 */
export const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(path.dirname(DB_PATH), 'ssh', 'dmw_ed25519')

/**
 * Admin account email. Defaults to 'admin@dmw.local' if ADMIN_EMAIL is not set.
 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dmw.local'

/**
 * Admin account password. Must be set via ADMIN_PASSWORD unless NODE_ENV is
 * explicitly 'development' or 'test', where it defaults to 'admin123'.
 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (allowsDevDefaults() ? 'admin123' : '')

/**
 * List of allowed CORS origins from environment variables.
 */
export const CORS_ORIGIN = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)

/**
 * Secure flag for refresh-token cookie.
 * Defaults to true in production to prevent token transmission over plain HTTP.
 * Override with COOKIE_SECURE=false only for local HTTP development.
 * An empty or whitespace-only value counts as unset.
 */
const cookieSecureRaw = process.env.COOKIE_SECURE?.trim()
export const COOKIE_SECURE =
  cookieSecureRaw
    ? cookieSecureRaw === 'true'
    : isProductionLike()

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

/** Minimum acceptable ADMIN_PASSWORD length outside development/test. */
const MIN_ADMIN_PASSWORD_LENGTH = 12

export const validateRuntimeConfig = (): void => {
  if (allowsDevDefaults()) {
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

  if (runtimeAdminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters in production mode.`)
  }

  const runtimeCorsOrigin = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)

  if (runtimeCorsOrigin.length === 0) {
    throw new Error(
      'CORS_ORIGIN must be set in production mode (e.g. CORS_ORIGIN=https://example.com,https://app.example.com).'
    )
  }

  if (process.platform !== 'win32') {
    try {
      if (fs.statSync(SSH_KEY_PATH).mode & 0o077) {
        throw new Error(`SSH server key ${SSH_KEY_PATH} is accessible by group/others; run chmod 600 on it.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
