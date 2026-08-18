/**
 * Application constants — application-wide configuration values
 * that should not be modified at runtime.
 */

// Server configuration
export const DEFAULT_PORT = 3001

// JWT configuration
/** Default JWT secret used in development. Must be overridden via environment
 * variable in production. */
export const DEFAULT_JWT_SECRET = 'dev-secret'

// Token configuration
/** Refresh token TTL — 7 days in milliseconds. Matches the database
 * expires_at column and cookie maxAge. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Default pairing code TTL — 10 minutes in milliseconds. */
export const PAIRING_TTL_MS = 10 * 60 * 1000

// Rate limit configuration
/** Default rate limit for authentication endpoints — 10 requests per minute. */
export const AUTH_RATE_LIMIT_MAX = 10
export const AUTH_RATE_LIMIT_TIME_WINDOW = '1 minute'

/** Default rate limit for refresh token endpoints — 30 requests per minute. */
export const REFRESH_RATE_LIMIT_MAX = 30
export const REFRESH_RATE_LIMIT_TIME_WINDOW = '1 minute'

/** Default rate limit for agent pairing endpoints — 5 requests per minute. */
export const AGENT_PAIR_RATE_LIMIT_MAX = 5

/** Default rate limit for device WOL endpoints — 5 requests per minute. */
export const DEVICE_WAKE_RATE_LIMIT_MAX = 5

// Cookie configuration
/** Flag for secure cookies in production environments. */
export const COOKIE_SECURE = true

// Device status constants — standardized status values used across the
// application. Using constants prevents typos and ensures consistency.
export const STATUS_NOT_PAIRED = 'NOT_PAIRED'
export const STATUS_ONLINE = 'ONLINE'
export const STATUS_OFFLINE = 'OFFLINE'
export const STATUS_WAKE_TIMEOUT = 'WAKE_TIMEOUT'

// Monitoring configuration
/** Time interval for monitoring updates — 10 seconds in milliseconds. */
export const MONITOR_INTERVAL_MS = 10 * 1000

/** Cooldown period for alert notifications — 5 minutes in milliseconds. */
export const ALERT_COOLDOWN_MS = 5 * 60 * 1000

// Alert threshold configuration
export const DEFAULT_ALERT_CPU_THRESHOLD = 85
export const DEFAULT_ALERT_MEMORY_THRESHOLD = 80
export const DEFAULT_ALERT_DISK_THRESHOLD = 90

// WOL (Wake-on-LAN) configuration
/** Standard WOL UDP port — 9. */
export const WOL_PORT = 9

// Database configuration
/** Default database file path relative to project root. */
export const DEFAULT_DB_PATH = 'data/dmw.db'
