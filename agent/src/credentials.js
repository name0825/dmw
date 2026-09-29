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
// ACL 제한이 실패하면 비밀값을 담은 파일을 남기지 않도록 실패로 처리한다(fail closed).
const restrictAclToCurrentUser = (filePath) => {
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!account) throw new Error('현재 사용자 계정을 확인할 수 없습니다.')
  execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${account}:F`], { stdio: 'ignore' })
}

export const writeState = (name, value, { restrictToOwner = false } = {}) => {
  fs.mkdirSync(getStateDir(), { recursive: true })
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
