import { useRef, useState } from 'react'

import { getApiBaseUrl, getWebSocketBaseUrl } from './api'
import { useAuth } from './hooks/useAuth'
import { useDeviceSocket } from './hooks/useDeviceSocket'
import { useDevices } from './hooks/useDevices'
import type { Device, DeviceHistoryEntry, PairingInfo } from './types'

/**
 * Main dashboard view for the DMW frontend.
 * The component coordinates auth state, device management, and pairing code issuance while keeping UI logic compact.
 */
export default function App() {
  const [message, setMessage] = useState('')
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null)

  const apiBase = getApiBaseUrl()
  const wsBase = getWebSocketBaseUrl()

  const resetDevicesRef = useRef<() => void>(() => {})

  const { login, setLogin, token, refreshSession, authedRequest, loginUser, logoutUser } = useAuth(
    apiBase,
    setMessage,
    () => {
      resetDevicesRef.current()
      setPairingInfo(null)
    },
  )

  const {
    devices,
    setDevices,
    alerts,
    historyByDevice,
    form,
    setForm,
    editingId,
    setEditingId,
    resetDevices,
    saveDevice,
    deleteDevice,
    editDevice,
    wakeDevice,
    loadHistory,
    summary,
  } = useDevices(apiBase, token, authedRequest, setMessage)

  resetDevicesRef.current = resetDevices

  useDeviceSocket(token, wsBase, refreshSession, logoutUser, setDevices)

  /**
   * Issue a pairing code that is not yet bound to any device.
   */
  const generatePairingCode = async () => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    const { res, data } = await authedRequest(`${apiBase}/pairing-codes`, { method: 'POST' })

    if (!res.ok) {
      setMessage(data?.message || '페어링 코드 발급 실패')
      return
    }

    setPairingInfo({ code: data.code, expiresAt: data.expiresAt })
    setMessage('페어링 코드가 발급되었습니다.')
  }

  /**
   * Issue a pairing code bound to an already-registered device, for re-pairing.
   * @param {Device} device - Device to bind the pairing code to.
   */
  const generateRepairingCode = async (device: Device) => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    const { res, data } = await authedRequest(`${apiBase}/pairing-codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: device.id }),
    })

    if (!res.ok) {
      setMessage(data?.message || '페어링 코드 발급 실패')
      return
    }

    setPairingInfo({ code: data.code, expiresAt: data.expiresAt, targetDeviceName: device.name })
    setMessage('페어링 코드가 발급되었습니다.')
  }

  /**
   * Copy the currently issued pairing code to the clipboard.
   */
  const copyPairingCode = async () => {
    if (!pairingInfo) return

    try {
      await navigator.clipboard.writeText(pairingInfo.code)
      setMessage('페어링 코드를 클립보드에 복사했습니다.')
    } catch {
      setMessage('클립보드 복사에 실패했습니다. 코드를 직접 입력해 주세요.')
    }
  }

  /**
   * Render a compact SVG chart for a target metric over recent device history.
   * @param {DeviceHistoryEntry[]} history - Recent history entries.
   * @param {'cpu_usage' | 'memory_usage' | 'disk_usage'} metric - Metric to visualize.
   * @returns {JSX.Element | null} SVG polyline or null when empty.
   */
  const renderTrendChart = (
    history: DeviceHistoryEntry[],
    metric: 'cpu_usage' | 'memory_usage' | 'disk_usage',
  ) => {
    if (!history.length) return null

    const values = [...history].slice(0, 8).reverse()
    const width = 220
    const height = 70
    const padding = 8
    const max = 100

    const points = values.map((entry, index) => {
      const value = Number(entry[metric] ?? 0)
      const x = padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1)
      const y = height - padding - (value / max) * (height - padding * 2)
      return `${x},${y}`
    }).join(' ')

    return (
      <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} trend`}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">DMW</p>
          <h1>Device Manager Web</h1>
        </div>
        {token ? (
          <button onClick={logoutUser}>로그아웃</button>
        ) : (
          <button onClick={loginUser}>로그인</button>
        )}
      </header>

      {!token ? (
        <section className="card auth-card">
          <h2>관리자 로그인</h2>
          <label>
            이메일
            <input value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
          </label>
          <label>
            비밀번호
            <input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
          </label>
          <button onClick={loginUser}>로그인</button>
        </section>
      ) : (
        <>
          <section className="card overview-panel">
            <h2>요약</h2>
            <div className="summary-grid">
              <div className="summary-card">
                <span>Total</span>
                <strong>{summary.total}</strong>
              </div>
              <div className="summary-card success">
                <span>Online</span>
                <strong>{summary.online}</strong>
              </div>
              <div className="summary-card danger">
                <span>Offline</span>
                <strong>{summary.offline}</strong>
              </div>
              <div className="summary-card warning">
                <span>Not paired</span>
                <strong>{summary.notPaired}</strong>
              </div>
            </div>
          </section>

          {alerts.length > 0 && (
            <section className="card alerts-panel">
              <h2>경고</h2>
              <div className="alert-list">
                {alerts.map((alert, idx) => (
                  <div key={`${alert.deviceId}-${idx}`} className={`alert-item ${alert.level}`}>
                    <strong>{alert.message}</strong>
                    <span>{alert.metric.toUpperCase()} {alert.value}%</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card pairing-card">
            <h2>에이전트 페어링 코드 발급</h2>
            <p>에이전트를 설치할 PC 의 DMW 에이전트 프로그램에 서버 주소와 아래 코드를 입력하면, 검증 성공 시 해당 PC 가 자동으로 디바이스 목록에 등록됩니다.</p>
            <div className="action-row">
              <button onClick={generatePairingCode}>페어링 코드 생성</button>
            </div>
            {pairingInfo && (
              <div className="pairing-box">
                <strong>발급된 페어링 코드</strong>
                {pairingInfo.targetDeviceName && <small>대상 디바이스: {pairingInfo.targetDeviceName}</small>}
                <div className="pairing-code">{pairingInfo.code}</div>
                <small>유효시간: {new Date(pairingInfo.expiresAt).toLocaleString()}</small>
                <small>서버 주소: {apiBase}</small>
                <div className="action-row">
                  <button className="secondary" onClick={copyPairingCode}>코드 복사</button>
                </div>
              </div>
            )}
          </section>

          <section className="card form-card">
            <h2>{editingId !== null ? '디바이스 수정' : '수동 디바이스 등록 (WOL 전용)'}</h2>
            <p>에이전트를 연결하지 않고 Wake-on-LAN 만 사용할 디바이스는 이름·MAC·IP 를 직접 입력해 등록하세요.</p>
            <div className="form-grid">
              <label>
                이름
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Home NAS" />
              </label>
              <label>
                MAC 주소
                <input value={form.mac_address} onChange={(e) => setForm({ ...form, mac_address: e.target.value })} placeholder="AA:BB:CC:DD:EE:FF" />
              </label>
              <label>
                IP 주소
                <input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} placeholder="192.168.0.20" />
              </label>
            </div>
            <div className="action-row">
              <button onClick={saveDevice}>{editingId !== null ? '저장' : '디바이스 등록'}</button>
              {editingId !== null && (
                <button className="secondary" onClick={() => {
                  setEditingId(null)
                  setForm({ name: '', mac_address: '', ip_address: '' })
                }}>취소</button>
              )}
            </div>
          </section>

          <section className="card status-panel">
            <h2>디바이스 상태</h2>
            {message && <p className="message">{message}</p>}
            <div className="device-list">
              {devices.length === 0 ? (
                <p>등록된 디바이스가 없습니다.</p>
              ) : (
                devices.map((device) => (
                  <div className="device-item" key={device.id}>
                    <div>
                      <h3>{device.name}</h3>
                      <p>{device.ip_address} · {device.mac_address}</p>
                      <small>{device.last_seen ? `Last seen: ${new Date(device.last_seen).toLocaleString()}` : 'Heartbeat 없음'}</small>
                      <div className="metric-stack">
                        <div>
                          <label>CPU</label>
                          <div className="meter"><span style={{ width: `${Math.min(device.cpu_usage ?? 0, 100)}%` }} /></div>
                          <small>{device.cpu_usage ?? 0}%</small>
                        </div>
                        <div>
                          <label>MEM</label>
                          <div className="meter"><span style={{ width: `${Math.min(device.memory_usage ?? 0, 100)}%` }} /></div>
                          <small>{device.memory_usage ?? 0}%</small>
                        </div>
                        <div>
                          <label>DISK</label>
                          <div className="meter"><span style={{ width: `${Math.min(device.disk_usage ?? 0, 100)}%` }} /></div>
                          <small>{device.disk_usage ?? 0}%</small>
                        </div>
                      </div>
                    </div>
                    <div className="device-meta">
                      <span className={`badge ${String(device.status).toLowerCase()}`}>{device.status}</span>
                      <span>{device.agent_paired ? 'Paired' : 'Not Paired'}</span>
                    </div>
                    <div className="device-actions">
                      <button onClick={() => editDevice(device)}>수정</button>
                      <button className="secondary" onClick={() => deleteDevice(device.id)}>삭제</button>
                      <button onClick={() => wakeDevice(device.id)}>Wake</button>
                      <button className="secondary" onClick={() => loadHistory(device.id)}>History</button>
                      {device.agent_paired && (
                        <button className="secondary" onClick={() => generateRepairingCode(device)}>재페어링 코드</button>
                      )}
                    </div>
                    {historyByDevice[device.id]?.length ? (
                      <div className="history-panel">
                        <strong>최근 메트릭</strong>
                        <div className="chart-row">
                          <div className="chart-box cpu">
                            <span>CPU</span>
                            {renderTrendChart(historyByDevice[device.id], 'cpu_usage')}
                          </div>
                          <div className="chart-box mem">
                            <span>MEM</span>
                            {renderTrendChart(historyByDevice[device.id], 'memory_usage')}
                          </div>
                          <div className="chart-box disk">
                            <span>DISK</span>
                            {renderTrendChart(historyByDevice[device.id], 'disk_usage')}
                          </div>
                        </div>
                        {historyByDevice[device.id].slice(0, 5).map((entry) => (
                          <div key={`${device.id}-${entry.timestamp}`} className="history-item">
                            <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                            <small>CPU {entry.cpu_usage ?? 0}%</small>
                            <small>MEM {entry.memory_usage ?? 0}%</small>
                            <small>DISK {entry.disk_usage ?? 0}%</small>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
