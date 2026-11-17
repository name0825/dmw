/**
 * Application constants — application-wide configuration values
 * that should not be modified at runtime.
 */

// Token configuration
/** Default pairing code TTL — 10 minutes in milliseconds. */
export const PAIRING_TTL_MS = 10 * 60 * 1000

// Rate limit configuration
export const RATE_LIMIT_TIME_WINDOW = '1 minute'

/** Default rate limit for authentication endpoints — 10 requests per minute. */
export const AUTH_RATE_LIMIT_MAX = 10

/** Default rate limit for refresh token endpoints — 30 requests per minute. */
export const REFRESH_RATE_LIMIT_MAX = 30

/** Default rate limit for agent pairing endpoints — 5 requests per minute. */
export const AGENT_PAIR_RATE_LIMIT_MAX = 5

/**
 * Default rate limit for agent heartbeat endpoints — 120 requests per minute.
 * Legitimate agents heartbeat at a minimum 1s interval (up to 60/min each), and
 * several agents may share one IP behind NAT, so this allows headroom for at
 * least 2 agents behind the same address while still bounding bcrypt-driven CPU cost.
 */
export const AGENT_HEARTBEAT_RATE_LIMIT_MAX = 120

/** Time after which a delivered or installing agent update with no progress is marked failed — 15 minutes. */
export const AGENT_UPDATE_STALE_MS = 15 * 60 * 1000

/** Message stored when an agent update is marked failed because the agent made no progress in time. */
export const AGENT_UPDATE_TIMEOUT_MESSAGE = '에이전트가 응답하지 않아 업데이트 시간이 초과되었습니다'

/** Default rate limit for agent unpair endpoints — 10 requests per minute. */
export const AGENT_UNPAIR_RATE_LIMIT_MAX = 10

/** Default rate limit for pairing code issuance — 10 requests per minute. */
export const PAIRING_CODE_RATE_LIMIT_MAX = 10

/** Default rate limit for device WOL endpoints — 5 requests per minute. */
export const DEVICE_WAKE_RATE_LIMIT_MAX = 5

// SSH remote command configuration
export const SSH_COMMAND_TIMEOUT_MS = 30 * 1000
export const SSH_CONNECT_TIMEOUT_MS = 5 * 1000
export const SSH_OUTPUT_LIMIT_BYTES = 64 * 1024
export const SSH_MAX_CONCURRENT = 4
export const SSH_COMMAND_MAX_LENGTH = 1024
export const SSH_EXEC_RATE_LIMIT_MAX = 10
export const COMMAND_RUN_RETENTION_DAYS = 90

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

