import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { getLatestAgentRelease, resetAgentReleaseCache } = await import('./services/agentRelease.js')

const releaseResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const fakeFetch = (bodies: unknown[]) => {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    return releaseResponse(bodies[Math.min(calls.length - 1, bodies.length - 1)])
  }
  return { fetchImpl, calls }
}

beforeEach(() => resetAgentReleaseCache())

test('release tags are parsed with and without the agent- prefix', async () => {
  for (const tag of ['v1.2.3', 'agent-v1.2.3']) {
    resetAgentReleaseCache()
    const { fetchImpl, calls } = fakeFetch([{ tag_name: tag, published_at: '2026-01-02T03:04:05Z' }])
    const result = await getLatestAgentRelease({ fetchImpl })
    assert.equal(result.version, '1.2.3')
    assert.equal(result.publishedAt, '2026-01-02T03:04:05.000Z')
    assert.equal(calls[0], 'https://api.github.com/repos/name0825/dmw/releases/latest')
  }
})

test('drafts, prereleases and malformed tags yield an error result instead of throwing', async () => {
  for (const body of [{ tag_name: 'v1.2.3', draft: true }, { tag_name: 'v1.2.3', prerelease: true }, { tag_name: 'v1.2' }, { tag_name: 'latest' }, {}]) {
    resetAgentReleaseCache()
    const result = await getLatestAgentRelease({ fetchImpl: fakeFetch([body]).fetchImpl })
    assert.equal(result.version, null)
    assert.ok(result.error)
  }
})

test('HTTP errors, network failures and oversized bodies are reported without leaking details', async () => {
  const failing = [
    async () => releaseResponse({}, 500),
    async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443') },
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
  ]
  for (const fetchImpl of failing) {
    resetAgentReleaseCache()
    const result = await getLatestAgentRelease({ fetchImpl })
    assert.equal(result.version, null)
    assert.ok(result.error)
    assert.doesNotMatch(result.error as string, /ECONNREFUSED|10\.0\.0\.1/)
  }
})

test('results are cached for 10 minutes and force only bypasses a cache older than 60 seconds', async () => {
  let clock = 1_000_000
  const now = () => clock
  const { fetchImpl, calls } = fakeFetch([{ tag_name: 'v1.0.0' }, { tag_name: 'v1.1.0' }, { tag_name: 'v1.2.0' }])

  assert.equal((await getLatestAgentRelease({ fetchImpl, now })).version, '1.0.0')
  clock += 30_000
  assert.equal((await getLatestAgentRelease({ fetchImpl, now, force: true })).version, '1.0.0')
  assert.equal(calls.length, 1)

  clock += 31_000
  assert.equal((await getLatestAgentRelease({ fetchImpl, now, force: true })).version, '1.1.0')
  assert.equal(calls.length, 2)

  clock += 9 * 60_000
  assert.equal((await getLatestAgentRelease({ fetchImpl, now })).version, '1.1.0')
  assert.equal(calls.length, 2)

  clock += 2 * 60_000
  assert.equal((await getLatestAgentRelease({ fetchImpl, now })).version, '1.2.0')
  assert.equal(calls.length, 3)
})

test('concurrent calls share a single in-flight request', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return releaseResponse({ tag_name: 'v2.0.0' })
  }
  const results = await Promise.all([1, 2, 3].map(() => getLatestAgentRelease({ fetchImpl, force: true })))
  assert.equal(calls, 1)
  assert.deepEqual(results.map((result) => result.version), ['2.0.0', '2.0.0', '2.0.0'])
})
