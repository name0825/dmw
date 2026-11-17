const RELEASE_URL = 'https://api.github.com/repos/name0825/dmw/releases/latest'
const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1024 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
const ERROR_CACHE_TTL_MS = 60 * 1000
const FORCE_MIN_AGE_MS = 60 * 1000
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

export type AgentReleaseResult = {
  version: string | null
  publishedAt?: string | null
  error?: string
  checkedAt: string
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

type Options = {
  force?: boolean
  fetchImpl?: FetchLike
  now?: () => number
}

let cached: { result: AgentReleaseResult; at: number } | null = null
let inFlight: Promise<AgentReleaseResult> | null = null

export const resetAgentReleaseCache = () => {
  cached = null
  inFlight = null
}

const readBody = async (response: Response): Promise<string> => {
  if (!response.body) throw new Error('empty body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const fetchLatest = async (fetchImpl: FetchLike, now: () => number): Promise<AgentReleaseResult> => {
  const checkedAt = new Date(now()).toISOString()
  try {
    const response = await fetchImpl(RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dmw-server' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return { version: null, error: `GitHub HTTP ${response.status}`, checkedAt }
    const release = JSON.parse(await readBody(response))
    if (!release || typeof release !== 'object' || release.draft || release.prerelease) {
      return { version: null, error: 'No stable release found', checkedAt }
    }
    const version = String(release.tag_name || '').replace(/^(agent-)?v/, '')
    if (!VERSION_PATTERN.test(version)) return { version: null, error: 'Unrecognized release version', checkedAt }
    const published = typeof release.published_at === 'string' && !Number.isNaN(Date.parse(release.published_at))
      ? new Date(release.published_at).toISOString()
      : null
    return { version, publishedAt: published, checkedAt }
  } catch (error) {
    console.warn('Failed to check latest agent release:', error instanceof Error ? error.message : error)
    return { version: null, error: 'Failed to check latest release', checkedAt }
  }
}

/**
 * GitHub 최신 안정 릴리스의 에이전트 버전을 조회한다. 고정 URL 만 호출하며 절대 throw 하지 않는다.
 * 10분간 캐시하고, force 는 캐시가 60초 이상 지났을 때만 캐시를 우회한다.
 * 동시 호출은 하나의 진행 중인 요청을 공유한다.
 */
export const getLatestAgentRelease = async (options: Options = {}): Promise<AgentReleaseResult> => {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike)
  const current = now()

  if (cached) {
    const age = current - cached.at
    const ttl = cached.result.version ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS
    if (age < ttl && !(options.force && age >= FORCE_MIN_AGE_MS)) return cached.result
  }

  if (inFlight) return inFlight

  const task = fetchLatest(fetchImpl, now).then((result) => {
    cached = { result, at: now() }
    return result
  }).finally(() => {
    if (inFlight === task) inFlight = null
  })
  inFlight = task
  return task
}
