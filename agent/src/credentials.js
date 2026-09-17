import fs from 'node:fs'
import path from 'node:path'
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
// icacls 실패는 무인 실행(서비스/예약 작업) 환경에서 console.warn만으로는 아무도
// 보지 못하므로, 상태 디렉터리에도 흔적을 남긴다. 파일은 매번 덮어써서 쌓이지 않는다.
const restrictAclToCurrentUser = (filePath) => {
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!account) return
  try {
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${account}:F`], { stdio: 'ignore' })
    try { fs.unlinkSync(path.join(getStateDir(), 'acl-warning.json')) } catch {}
  } catch (error) {
    console.warn(`[credentials] Windows ACL 제한 실패 (${filePath}): ${error.message}`)
    try {
      writeState('acl-warning.json', { timestamp: new Date().toISOString(), filePath, message: error.message })
    } catch {}
  }
}

export const writeState = (name, value, { restrictToOwner = false } = {}) => {
  fs.mkdirSync(getStateDir(), { recursive: true })
  const target = path.join(getStateDir(), name)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, target)
  if (restrictToOwner && process.platform === 'win32') restrictAclToCurrentUser(target)
}
export const loadCredentials = () => {
  const data = readState('credentials.json')
  return data?.apiKey && data?.deviceId && data?.serverUrl ? data : null
}
export const saveCredentials = (credentials) => writeState('credentials.json', credentials, { restrictToOwner: true })
export const clearCredentials = (expected) => {
  if (expected && loadCredentials()?.apiKey !== expected.apiKey) return false
  writeState('credentials.json', null, { restrictToOwner: true })
  return true
}
export const acquireLock = (name) => {
  fs.mkdirSync(getStateDir(), { recursive: true })
  const file = path.join(getStateDir(), `${name}.lock`)
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    fs.writeFileSync(fd, String(process.pid))
    fs.closeSync(fd)
    return () => fs.unlinkSync(file)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(fs.readFileSync(file, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${name} 잠금 파일을 확인하세요: ${file}`)
    try { process.kill(pid, 0); return null } catch (probe) {
      if (probe.code !== 'ESRCH') return null
      const reclaimed = `${file}.${process.pid}.stale`
      try { fs.renameSync(file, reclaimed) } catch (renameError) {
        if (renameError.code === 'ENOENT') return null
        throw renameError
      }
      fs.unlinkSync(reclaimed)
      return acquireLock(name)
    }
  }
}
