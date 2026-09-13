import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { getStateDir, readState, writeState, acquireLock } from './credentials.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
export const isNewerVersion = (candidate, current) => {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return false
}
export const validateBundle = (bytes, checksum, version) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('잘못된 버전')
  const expected = checksum.trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/i.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw new Error('업데이트 SHA256 검증 실패')
  const bundle = JSON.parse(bytes.toString('utf8'))
  if (bundle.version !== version || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw new Error('잘못된 업데이트 형식')
  const entries = Object.entries(bundle.files)
  if (entries.length > 200) throw new Error('업데이트 파일 수 초과')
  for (const [name, content] of entries) {
    if (!(name === 'package.json' || /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(name)) || typeof content !== 'string') throw new Error(`허용되지 않은 업데이트 경로: ${name}`)
  }
  if (!bundle.files['src/index.js'] || !bundle.files['package.json']) throw new Error('필수 업데이트 파일 누락')
  const pkg = JSON.parse(bundle.files['package.json'])
  if (pkg.version !== version || pkg.type !== 'module' || Object.keys(pkg.dependencies || {}).length) throw new Error('업데이트 package.json 검증 실패')
  return bundle
}
const download = async (url, limit, fetchImpl) => {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dmw-agent' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('업데이트 다운로드 크기 초과')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
export const checkForUpdate = async ({ fetchImpl = fetch, version = currentVersion } = {}) => {
  const unlock = acquireLock('update')
  if (!unlock) return false
  try {
    const release = JSON.parse((await download('https://api.github.com/repos/name0825/dmw/releases/latest', 1024 * 1024, fetchImpl)).toString('utf8'))
    const next = String(release.tag_name || '').replace(/^(agent-)?v/, '')
    if (release.draft || release.prerelease || !isNewerVersion(next, version)) return false
    if (readState('active.json')?.version === next) return false
    const name = `dmw-agent-${next}.json`
    const assetUrl = (assetName) => {
      const asset = release.assets?.find((item) => item.name === assetName)
      if (!asset) throw new Error(`릴리스 파일 누락: ${assetName}`)
      const url = new URL(asset.browser_download_url)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/name0825/dmw/releases/download/') || url.username || url.password) throw new Error('허용되지 않은 릴리스 URL')
      return url.href
    }
    const bytes = await download(assetUrl(name), 10 * 1024 * 1024, fetchImpl)
    const checksum = (await download(assetUrl(`${name}.sha256`), 4096, fetchImpl)).toString('utf8')
    const bundle = validateBundle(bytes, checksum, next)
    const destination = path.join(getStateDir(), 'versions', next)
    if (fs.existsSync(destination)) {
      const matches = Object.entries(bundle.files).every(([name, content]) => {
        const existing = path.join(destination, name)
        return fs.existsSync(existing) && fs.readFileSync(existing, 'utf8') === content
      })
      if (matches) {
        const check = spawnSync(process.execPath, [path.join(destination, 'src/index.js'), '--help'], { timeout: 15000, encoding: 'utf8', windowsHide: true })
        if (check.error || check.status !== 0) throw new Error('기존 업데이트 시작 검증 실패')
        writeState('active.json', { version: next })
        return true
      }
      // 내용이 다른 versions/<next>는 손상된 잔여물이므로 재검증된 다운로드로 다시 스테이징한다.
      if (readState('active.json')?.version === next) throw new Error('활성 버전 디렉토리가 손상되어 자동 복구할 수 없습니다')
      const versionsRoot = path.resolve(getStateDir(), 'versions')
      const resolved = path.resolve(destination)
      if (path.dirname(resolved) !== versionsRoot) throw new Error('허용되지 않은 업데이트 경로')
      fs.rmSync(resolved, { recursive: true, force: true })
    }
    const staging = `${destination}.${process.pid}.${Date.now()}.tmp`
    fs.mkdirSync(staging, { recursive: true })
    try {
      for (const [name, content] of Object.entries(bundle.files)) {
        const target = path.join(staging, name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' })
      }
      const check = spawnSync(process.execPath, [path.join(staging, 'src/index.js'), '--help'], { timeout: 15000, encoding: 'utf8', windowsHide: true })
      if (check.error || check.status !== 0) throw new Error(`새 버전 시작 검증 실패: ${check.error?.message || check.stderr}`)
      fs.renameSync(staging, destination)
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
    writeState('active.json', { version: next })
    return true
  } finally { unlock() }
}
