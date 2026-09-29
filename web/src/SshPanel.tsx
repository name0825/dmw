import { useEffect, useState } from 'react'

import type { CommandRun, Device, SshRunResult } from './types'

type AuthedRequest = (url: string, init?: RequestInit) => Promise<{ res: Response; data: any }>

type SshPanelProps = {
  device: Device
  apiBase: string
  authedRequest: AuthedRequest
}

type SshConfig = { username: string; port: number; hostKey: string } | null

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * SSH remote command panel for a single device: server public key, host key
 * confirmation, command execution with password re-entry, and run history.
 */
export default function SshPanel({ device, apiBase, authedRequest }: SshPanelProps) {
  const [publicKey, setPublicKey] = useState('')
  const [username, setUsername] = useState(device.ssh_username ?? '')
  const [port, setPort] = useState(String(device.ssh_port ?? 22))
  const [scanned, setScanned] = useState('')
  const [command, setCommand] = useState('')
  const [password, setPassword] = useState('')
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SshRunResult | null>(null)
  const [runs, setRuns] = useState<CommandRun[]>([])
  const [notice, setNotice] = useState('')

  const config: SshConfig = device.ssh_username && device.ssh_port && device.ssh_host_key
    ? { username: device.ssh_username, port: device.ssh_port, hostKey: device.ssh_host_key }
    : null

  const loadRuns = async () => {
    const { res, data } = await authedRequest(`${apiBase}/devices/${device.id}/commands?limit=10`)
    if (res.ok) setRuns(data?.runs ?? [])
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { res, data } = await authedRequest(`${apiBase}/ssh/public-key`)
      if (!cancelled && res.ok) setPublicKey(data?.publicKey ?? '')
      const runsResponse = await authedRequest(`${apiBase}/devices/${device.id}/commands?limit=10`)
      if (!cancelled && runsResponse.res.ok) setRuns(runsResponse.data?.runs ?? [])
    }
    load().catch(() => {
      if (!cancelled) setNotice('SSH 정보를 불러오지 못했습니다.')
    })
    return () => {
      cancelled = true
    }
  }, [device.id, apiBase, authedRequest])

  const copyPublicKey = async () => {
    try {
      await navigator.clipboard.writeText(publicKey)
      setNotice('공개키를 클립보드에 복사했습니다.')
    } catch {
      setNotice('클립보드 복사에 실패했습니다. 공개키를 직접 복사해 주세요.')
    }
  }

  const scan = async () => {
    if (busy) return
    setNotice('')
    setScanned('')
    setBusy(true)
    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${device.id}/ssh/scan`, jsonInit('POST', { port: Number(port) }))
      if (!res.ok) {
        setNotice(data?.message || 'Host key 스캔에 실패했습니다.')
        return
      }
      setScanned(data.fingerprint)
    } catch {
      setNotice('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const saveConfig = async () => {
    if (busy) return
    setNotice('')
    setBusy(true)
    try {
      const { res, data } = await authedRequest(
        `${apiBase}/devices/${device.id}/ssh`,
        jsonInit('PUT', { username, port: Number(port), hostKeyFingerprint: scanned, password }),
      )
      setPassword('')
      if (!res.ok) {
        setNotice(data?.message || 'SSH 설정 저장에 실패했습니다.')
        return
      }
      setScanned('')
      setNotice('SSH 설정을 저장했습니다.')
    } catch {
      setNotice('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const removeConfig = async () => {
    if (busy) return
    setNotice('')
    setBusy(true)
    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${device.id}/ssh`, jsonInit('DELETE', { password }))
      setPassword('')
      if (!res.ok) {
        setNotice(data?.message || 'SSH 설정 해제에 실패했습니다.')
        return
      }
      setNotice('SSH 설정을 해제했습니다.')
    } catch {
      setNotice('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const execute = async () => {
    setNotice('')
    setResult(null)
    setRunning(true)
    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${device.id}/commands`, jsonInit('POST', { command, password }))
      setPassword('')
      if (!res.ok) {
        setNotice(data?.message || '명령 실행에 실패했습니다.')
      } else {
        setResult(data)
      }
    } catch {
      setNotice('네트워크 오류로 요청에 실패했습니다.')
      setRunning(false)
      return
    }
    setRunning(false)
    try {
      await loadRuns()
    } catch {
      setNotice((current) => current || '실행 기록을 불러오지 못했습니다.')
    }
  }

  const outcome = (run: { exitCode: number | null; signal: string | null; error?: string | null }) => {
    if (run.error) return run.error
    if (run.exitCode === null) return '연결 종료'
    return `exit ${run.exitCode}`
  }

  return (
    <div className="history-panel ssh-panel">
      <strong>SSH 원격 명령</strong>

      <small>서버 공개키를 기기의 authorized_keys 에 추가해야 합니다.</small>
      <pre className="ssh-output">{publicKey || '...'}</pre>
      <div className="action-row">
        <button className="secondary" onClick={copyPublicKey} disabled={!publicKey}>공개키 복사</button>
      </div>

      <div className="form-grid">
        <label>
          사용자
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </label>
        <label>
          포트
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <div className="action-row">
        <button className="secondary" onClick={scan} disabled={busy}>{busy ? '처리 중...' : 'Host key 스캔'}</button>
        {config && <button className="secondary" onClick={removeConfig} disabled={busy || !password}>SSH 설정 해제</button>}
      </div>
      {scanned && (
        <div className="ssh-confirm">
          <small>기기가 제시한 host key 지문입니다. 기기에서 확인한 값과 일치할 때만 저장하세요.</small>
          <pre className="ssh-output">{scanned}</pre>
          <div className="action-row">
            <button onClick={saveConfig} disabled={busy || !username || !password}>이 지문을 신뢰하고 저장</button>
          </div>
        </div>
      )}
      {config && <small>신뢰된 기기: {config.username}@{device.ip_address}:{config.port} · {config.hostKey}</small>}

      {(config || scanned) && (
        <label>
          관리자 비밀번호 재입력
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
      )}

      {config && (
        <>
          <label>
            명령
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sudo reboot" />
          </label>
          <div className="action-row">
            <button onClick={execute} disabled={running || !command.trim() || !password}>{running ? '실행 중...' : '실행'}</button>
          </div>
        </>
      )}

      {notice && <p className="message">{notice}</p>}

      {result && (
        <div>
          <small>{outcome(result)}{result.signal ? ` (${result.signal})` : ''} · {result.durationMs}ms{result.truncated ? ' · 출력이 잘렸습니다' : ''}</small>
          {result.stdout && <pre className="ssh-output">{result.stdout}</pre>}
          {result.stderr && <pre className="ssh-output ssh-stderr">{result.stderr}</pre>}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <strong>최근 실행</strong>
          {runs.map((run) => (
            <div key={run.id} className="history-item">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <small>{run.command}</small>
              <small>{outcome(run)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
