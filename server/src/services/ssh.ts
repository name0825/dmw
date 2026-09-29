import ssh2 from 'ssh2'

import {
  COMMAND_RUN_RETENTION_DAYS,
  SSH_COMMAND_TIMEOUT_MS,
  SSH_CONNECT_TIMEOUT_MS,
  SSH_MAX_CONCURRENT,
  SSH_OUTPUT_LIMIT_BYTES,
} from '../config/constants.js'
import { getDb } from '../database/index.js'
import { ensureServerKey } from './sshKey.js'

const { Client } = ssh2

export type SshErrorCode =
  | 'NOT_CONFIGURED'
  | 'HOST_KEY_MISMATCH'
  | 'TIMEOUT'
  | 'AUTH'
  | 'CONNECT'
  | 'KEY_UNAVAILABLE'
  | 'DEVICE_BUSY'
  | 'GLOBAL_BUSY'

export class SshError extends Error {
  code: SshErrorCode
  stdout = ''
  stderr = ''
  runId: number | null = null

  constructor(code: SshErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type ExecRequest = {
  host: string
  port: number
  username: string
  privateKey: string
  expectedFingerprint: string
  command: string
  timeoutMs: number
  limitBytes: number
}

export type ExecResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  error?: string
}

export type SshTransport = {
  scanHostKey: (host: string, port: number, timeoutMs: number) => Promise<string>
  exec: (request: ExecRequest) => Promise<ExecResult>
}

export type SshDeps = {
  transport: SshTransport
  getPrivateKey?: () => Promise<string>
}

export type SshDevice = {
  id: number
  name: string
  ip_address: string
  ssh_username: string | null
  ssh_port: number | null
  ssh_host_key: string | null
}

export type CommandRunResult = {
  runId: number
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

export const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/

/**
 * ssh2 가 hostHash 로 넘겨주는 hex 다이제스트를 OpenSSH 표기(SHA256:base64, 패딩 없음)로 바꾼다.
 */
export const toFingerprint = (hexDigest: string): string =>
  `SHA256:${Buffer.from(hexDigest, 'hex').toString('base64').replace(/=+$/, '')}`

/**
 * 바이트 상한까지만 버퍼링하고, 넘치는 분량은 버리며 truncated 로 표시한다.
 */
export const createOutputBuffer = (limitBytes: number) => {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  return {
    push(chunk: Buffer) {
      const remaining = limitBytes - size
      if (chunk.length > remaining) truncated = true
      if (remaining <= 0) return
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(kept)
      size += kept.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    isTruncated: () => truncated,
  }
}

const clampOutput = (text: string, limitBytes: number): { text: string; truncated: boolean } => {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= limitBytes) return { text, truncated: false }
  return { text: buffer.subarray(0, limitBytes).toString('utf8'), truncated: true }
}

const activeDevices = new Set<number>()

/**
 * 기기당 1개·전역 SSH_MAX_CONCURRENT 개 동시 실행 슬롯을 잡고, 해제 함수를 돌려준다.
 * @throws {SshError} DEVICE_BUSY 또는 GLOBAL_BUSY
 */
export const acquireSlot = (deviceId: number): (() => void) => {
  if (activeDevices.has(deviceId)) throw new SshError('DEVICE_BUSY', 'A command is already running on this device')
  if (activeDevices.size >= SSH_MAX_CONCURRENT) throw new SshError('GLOBAL_BUSY', 'Too many concurrent SSH commands')
  activeDevices.add(deviceId)
  let released = false
  return () => {
    if (released) return
    released = true
    activeDevices.delete(deviceId)
  }
}

const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SshError('TIMEOUT', 'Command timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

const toSshError = (error: unknown): SshError => {
  if (error instanceof SshError) return error
  console.error('Unexpected SSH transport failure:', (error as Error)?.message)
  return new SshError('CONNECT', 'SSH connection failed')
}

/**
 * 기기에서 명령을 실행하고 결과를 command_runs 에 한 행으로 남긴다.
 * 슬롯은 성공/실패/타임아웃 모든 경로에서 해제된다.
 * @throws {SshError} 실행 시도 이후의 실패는 runId 가 채워진다.
 */
export const runCommand = async (
  deps: SshDeps,
  device: SshDevice,
  userId: number,
  command: string,
): Promise<CommandRunResult> => {
  if (!device.ssh_username || !device.ssh_port || !device.ssh_host_key) {
    throw new SshError('NOT_CONFIGURED', 'SSH is not configured for this device')
  }

  const release = acquireSlot(device.id)
  try {
    const db = getDb()
    const startedAt = Date.now()
    const inserted = await db.run(
      'INSERT INTO command_runs (device_id, device_name, user_id, command, truncated, started_at) VALUES (?, ?, ?, ?, 0, ?)',
      [device.id, device.name, userId, command, new Date(startedAt).toISOString()],
    )
    const runId: number = inserted.lastID

    try {
      let privateKey: string
      try {
        privateKey = await (deps.getPrivateKey ?? ensureServerKey)()
      } catch (keyError) {
        console.error('SSH server key unavailable:', (keyError as Error)?.message)
        throw new SshError('KEY_UNAVAILABLE', 'SSH server key is unavailable')
      }
      const raw = await withDeadline(
        deps.transport.exec({
          host: device.ip_address,
          port: device.ssh_port,
          username: device.ssh_username,
          privateKey,
          expectedFingerprint: device.ssh_host_key,
          command,
          timeoutMs: SSH_COMMAND_TIMEOUT_MS,
          limitBytes: SSH_OUTPUT_LIMIT_BYTES,
        }),
        SSH_COMMAND_TIMEOUT_MS + SSH_CONNECT_TIMEOUT_MS + 2000,
      )
      const stdout = clampOutput(raw.stdout, SSH_OUTPUT_LIMIT_BYTES)
      const stderr = clampOutput(raw.stderr, SSH_OUTPUT_LIMIT_BYTES)
      const truncated = raw.truncated || stdout.truncated || stderr.truncated
      const finishedAt = Date.now()
      await db.run(
        'UPDATE command_runs SET exit_code = ?, signal = ?, stdout = ?, stderr = ?, truncated = ?, error = ?, finished_at = ? WHERE id = ?',
        [raw.exitCode, raw.signal, stdout.text, stderr.text, truncated ? 1 : 0, raw.error ?? null, new Date(finishedAt).toISOString(), runId],
      )
      return {
        runId,
        exitCode: raw.exitCode,
        signal: raw.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated,
        durationMs: finishedAt - startedAt,
      }
    } catch (error) {
      const sshError = toSshError(error)
      sshError.runId = runId
      const stdout = clampOutput(sshError.stdout, SSH_OUTPUT_LIMIT_BYTES)
      const stderr = clampOutput(sshError.stderr, SSH_OUTPUT_LIMIT_BYTES)
      try {
        await db.run(
          'UPDATE command_runs SET error = ?, stdout = ?, stderr = ?, truncated = ?, finished_at = ? WHERE id = ?',
          [sshError.message, stdout.text, stderr.text, stdout.truncated || stderr.truncated ? 1 : 0, new Date().toISOString(), runId],
        )
      } catch (updateError) {
        console.error('Failed to finalize command run:', (updateError as Error)?.message)
      }
      throw sshError
    }
  } finally {
    release()
  }
}

export type SshAuditEntry = {
  event: 'config_set' | 'config_clear' | 'command_reauth_failed' | 'config_reauth_failed'
  userId: number | null
  deviceId: number | null
  before?: { username: string | null; port: number | null; fingerprint: string | null }
  after?: { username: string | null; port: number | null; fingerprint: string | null }
}

/**
 * SSH 설정 변경과 재인증 실패를 ssh_audit 에 한 행으로 남긴다.
 * @param db - 트랜잭션 안에서 쓸 때 넘기는 DB 연결 (기본값: getDb())
 */
export const recordSshAudit = async (entry: SshAuditEntry, db: any = getDb()): Promise<void> => {
  await db.run(
    `INSERT INTO ssh_audit (event, user_id, device_id, old_username, old_port, old_fingerprint, new_username, new_port, new_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.event,
      entry.userId,
      entry.deviceId,
      entry.before?.username ?? null,
      entry.before?.port ?? null,
      entry.before?.fingerprint ?? null,
      entry.after?.username ?? null,
      entry.after?.port ?? null,
      entry.after?.fingerprint ?? null,
      new Date().toISOString(),
    ],
  )
}

/**
 * 보존 기간이 지난 command_runs 행을 지운다.
 */
export const pruneCommandRuns = async (db: any = getDb()): Promise<number> => {
  const cutoff = new Date(Date.now() - COMMAND_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.run('DELETE FROM command_runs WHERE started_at < ?', [cutoff])
  return result.changes ?? 0
}

export const ssh2Transport: SshTransport = {
  scanHostKey: (host, port, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      const client = new Client()
      let seen: string | null = null
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.destroy()
        action()
      }
      const timer = setTimeout(() => finish(() => reject(new SshError('TIMEOUT', 'Host key scan timed out'))), timeoutMs)
      const onEnd = () =>
        finish(() => (seen ? resolve(seen) : reject(new SshError('CONNECT', 'Could not read the host key'))))
      client.on('error', onEnd)
      client.on('close', onEnd)
      try {
        client.connect({
          host,
          port,
          username: 'dmw-scan',
          hostHash: 'sha256',
          hostVerifier: (hash: string | Buffer) => {
            seen = toFingerprint(String(hash))
            return false
          },
          readyTimeout: timeoutMs,
        })
      } catch {
        finish(() => reject(new SshError('CONNECT', 'Could not read the host key')))
      }
    }),

  exec: (request) =>
    new Promise<ExecResult>((resolve, reject) => {
      const client = new Client()
      const stdout = createOutputBuffer(request.limitBytes)
      const stderr = createOutputBuffer(request.limitBytes)
      let settled = false
      let execStarted = false
      let mismatch = false
      let exitCode: number | null = null
      let signal: string | null = null
      let channel: { signal: (name: string) => void } | null = null

      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.destroy()
        action()
      }
      const succeed = () =>
        finish(() =>
          resolve({
            exitCode,
            signal,
            stdout: stdout.text(),
            stderr: stderr.text(),
            truncated: stdout.isTruncated() || stderr.isTruncated(),
            ...(exitCode === null && signal === null ? { error: 'connection closed before exit status' } : {}),
          }),
        )
      const fail = (code: SshErrorCode, message: string) =>
        finish(() => {
          const error = new SshError(code, message)
          error.stdout = stdout.text()
          error.stderr = stderr.text()
          reject(error)
        })

      const timer = setTimeout(() => {
        try {
          channel?.signal('KILL')
        } catch {
          channel = null
        }
        fail('TIMEOUT', 'Command timed out')
      }, request.timeoutMs)

      client.on('ready', () => {
        client.exec(request.command, (execError, stream) => {
          if (execError) {
            fail('CONNECT', 'Failed to start the command')
            return
          }
          execStarted = true
          channel = stream
          stream.on('data', (chunk: Buffer) => stdout.push(chunk))
          stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
          stream.on('close', (code: number | null | undefined, sig: string | null | undefined) => {
            exitCode = typeof code === 'number' ? code : null
            signal = sig ?? null
            succeed()
          })
        })
      })

      client.on('error', (error: Error & { level?: string }) => {
        if (mismatch) fail('HOST_KEY_MISMATCH', 'Host key does not match the trusted fingerprint')
        else if (execStarted) succeed()
        else if (error.level === 'client-authentication') fail('AUTH', 'SSH authentication failed')
        else fail('CONNECT', 'SSH connection failed')
      })

      client.on('close', () => {
        if (mismatch) fail('HOST_KEY_MISMATCH', 'Host key does not match the trusted fingerprint')
        else if (execStarted) succeed()
        else fail('CONNECT', 'SSH connection closed before the command started')
      })

      try {
        client.connect({
          host: request.host,
          port: request.port,
          username: request.username,
          privateKey: request.privateKey,
          hostHash: 'sha256',
          hostVerifier: (hash: string | Buffer) => {
            const trusted = FINGERPRINT_PATTERN.test(request.expectedFingerprint) &&
              toFingerprint(String(hash)) === request.expectedFingerprint
            if (!trusted) mismatch = true
            return trusted
          },
          readyTimeout: Math.min(SSH_CONNECT_TIMEOUT_MS, request.timeoutMs),
        })
      } catch {
        fail('CONNECT', 'SSH connection failed')
      }
    }),
}
