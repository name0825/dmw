import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const getStateDir = () => path.resolve(process.env.DMW_STATE_DIR || path.join(sourceRoot, 'data'))
export const readState = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(getStateDir(), name), 'utf8')) } catch { return null }
}

// fs `mode` has no effect on Windows; access is governed by the ACL inherited
// from the parent directory. Restrict the credentials file to the current
// user so other local accounts on a shared machine cannot read the API key.
// ACL 제한이 실패하면 비밀값을 담은 파일을 남기지 않도록 실패로 처리한다(fail closed).
const currentAccount = () => {
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!account) throw new Error('현재 사용자 계정을 확인할 수 없습니다.')
  return account
}
const restrictAclToCurrentUser = (filePath) => {
  execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${currentAccount()}:F`], { stdio: 'ignore' })
}

// 상태 디렉터리는 소유자만 접근하도록 만든다. Unix는 0700(기존 디렉터리도 chmod),
// Windows는 새로 만들었을 때 한 번만 현재 사용자·SYSTEM·Administrators(SID)로 ACL을 제한한다.
// 실패해도 경고만 남기고 계속 진행한다(파일 자체는 별도로 보호된다).
export const ensureStateDir = (dir = getStateDir(), { platform = process.platform, run = execFileSync } = {}) => {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    if (platform !== 'win32') {
      fs.chmodSync(dir, 0o700)
    } else if (created) {
      run('icacls', [dir, '/inheritance:r', '/grant:r', `${currentAccount()}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore' })
    }
  } catch (error) {
    console.warn(`[credentials] 상태 디렉터리 권한 제한 실패 (${dir}): ${error.message}`)
  }
}

export const writeState = (name, value, { restrictToOwner = false } = {}) => {
  ensureStateDir()
  const target = path.join(getStateDir(), name)
  const temporary = `${target}.${process.pid}.tmp`
  const restrictFirst = restrictToOwner && process.platform === 'win32'
  if (restrictFirst) {
    fs.writeFileSync(temporary, '', { mode: 0o600 })
    try {
      restrictAclToCurrentUser(temporary)
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch {}
      throw new Error(`[credentials] Windows ACL 제한 실패 (${temporary}): ${error.message}`)
    }
  }
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, target)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}
export const loadCredentials = () => {
  const data = readState('credentials.json')
  return data?.apiKey && data?.deviceId && data?.serverUrl ? data : null
}
export const saveCredentials = (credentials) => writeState('credentials.json', credentials, { restrictToOwner: true })
// 지울 값에는 비밀이 없으므로 ACL 제한이 필요한 writeState 대신 파일을 바로 삭제한다.
export const clearCredentials = (expected) => {
  if (expected && loadCredentials()?.apiKey !== expected.apiKey) return false
  fs.rmSync(path.join(getStateDir(), 'credentials.json'), { force: true })
  return true
}
const bootTime = () => Math.round(Date.now() / 1000 - os.uptime())
const parseLock = (text) => {
  try {
    const value = JSON.parse(text)
    if (Number.isInteger(value)) return { pid: value }
    if (value && Number.isInteger(value.pid) && typeof value.boot === 'number') return value
  } catch {}
  return null
}
const isStaleLock = (file) => {
  const info = parseLock(fs.readFileSync(file, 'utf8').trim())
  if (!info || info.pid <= 0) return Date.now() - fs.statSync(file).mtimeMs >= 10000
  if (info.boot !== undefined && Math.abs(info.boot - bootTime()) > 120 && Date.now() - fs.statSync(file).mtimeMs > 45000) return true
  try { process.kill(info.pid, 0); return false } catch (probe) { return probe.code === 'ESRCH' }
}
export const acquireLock = (name) => {
  ensureStateDir()
  const file = path.join(getStateDir(), `${name}.lock`)
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, boot: bootTime() }))
    fs.closeSync(fd)
    const beat = setInterval(() => { try { const now = new Date(); fs.utimesSync(file, now, now) } catch {} }, 10000).unref()
    return () => { clearInterval(beat); fs.unlinkSync(file) }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let stale
    try { stale = isStaleLock(file) } catch (readError) {
      if (readError.code === 'ENOENT') return acquireLock(name)
      throw readError
    }
    if (!stale) return null
    const reclaimed = `${file}.${process.pid}.stale`
    try { fs.renameSync(file, reclaimed) } catch (renameError) {
      if (renameError.code === 'ENOENT') return null
      throw renameError
    }
    fs.unlinkSync(reclaimed)
    return acquireLock(name)
  }
}
