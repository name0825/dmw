import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ssh2 from 'ssh2'

import { SSH_KEY_PATH, isProductionLike } from '../config.js'

const { utils } = ssh2

const PUBLIC_KEY_COMMENT = 'dmw-server'

const pending = new Map<string, Promise<string>>()
let permissionWarned = false

const derivePublicKey = (privateKey: string): string => {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw new Error('SSH server key is not a valid private key')
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  return `${key.type} ${key.getPublicSSH().toString('base64')} ${PUBLIC_KEY_COMMENT}`
}

const readExisting = async (keyPath: string): Promise<string | null> => {
  try {
    const privateKey = await fs.readFile(keyPath, 'utf8')
    if (process.platform !== 'win32') {
      const { mode } = await fs.stat(keyPath)
      if (mode & 0o077) {
        if (isProductionLike()) {
          throw new Error(`SSH server key ${keyPath} is accessible by group/others; run chmod 600 on it`)
        }
        if (!permissionWarned) {
          permissionWarned = true
          console.warn(`SSH server key ${keyPath} is accessible by group/others; restrict it to owner-only (chmod 600)`)
        }
      }
    }
    return privateKey
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const loadOrCreate = async (keyPath: string): Promise<string> => {
  const existing = await readExisting(keyPath)
  if (existing !== null) return existing

  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 })
  const { private: privateKey } = utils.generateKeyPairSync('ed25519')
  const tempPath = `${keyPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(tempPath, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(tempPath, keyPath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  }
  return privateKey
}

/**
 * 서버 SSH 개인키를 반환한다. 파일이 없으면 ed25519 키쌍을 만들어 0600 임시 파일에 쓴 뒤 rename 으로 배치한다.
 * 프로세스 안에서는 경로별로 하나의 프라미스만 공유하므로 동시 최초 호출도 같은 키를 돌려받는다.
 * @param keyPath - 개인키 파일 경로 (기본값: SSH_KEY_PATH)
 */
export const ensureServerKey = (keyPath: string = SSH_KEY_PATH): Promise<string> => {
  let promise = pending.get(keyPath)
  if (!promise) {
    promise = loadOrCreate(keyPath)
    pending.set(keyPath, promise)
    promise.catch(() => pending.delete(keyPath))
  }
  return promise
}

/**
 * 기기의 authorized_keys 에 추가할 서버 공개키(OpenSSH 형식)를 반환한다.
 * @param keyPath - 개인키 파일 경로 (기본값: SSH_KEY_PATH)
 */
export const getPublicKey = async (keyPath: string = SSH_KEY_PATH): Promise<string> =>
  derivePublicKey(await ensureServerKey(keyPath))
