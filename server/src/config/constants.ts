/**
 * Application constants — application-wide configuration values
 * that should not be modified at runtime.
 */

// Token configuration
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

/** Default rate limit for pairing code issuance — 10 requests per minute. */
export const PAIRING_CODE_RATE_LIMIT_MAX = 10

/** Default rate limit for device WOL endpoints — 5 requests per minute. */
export const DEVICE_WAKE_RATE_LIMIT_MAX = 5

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

/** Retention period for stored alert records — 30 days in milliseconds. */
export const ALERT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Alert threshold configuration
export const DEFAULT_ALERT_CPU_THRESHOLD = 85
export const DEFAULT_ALERT_MEMORY_THRESHOLD = 80
export const DEFAULT_ALERT_DISK_THRESHOLD = 90

// WOL (Wake-on-LAN) configuration
/** Standard WOL UDP port — 9. */
export const WOL_PORT = 9

