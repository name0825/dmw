import { useEffect, useState } from 'react'

import { getApiBaseUrl, getWebSocketBaseUrl, mapHistory, normalizeAlerts, normalizeDevices, requestJson } from './api'
import { DEFAULT_AGENT_STATE, IPV4_RE, MAC_RE } from './constants'
import type { AgentState, AlertItem, Device, DeviceForm, DeviceHistoryEntry } from './types'

/**
 * Validate a MAC address in canonical `AA:BB:CC:DD:EE:FF` form.
 * @param {string} value - MAC address candidate.
 * @returns {boolean} True when the format is valid.
 */
const isValidMac = (value: string) => MAC_RE.test(value.trim())

/**
 * Validate a dotted IPv4 address.
 * @param {string} value - IP candidate.
 * @returns {boolean} True when the IPv4 format is valid.
 */
const isValidIp = (value: string) => IPV4_RE.test(value.trim())

/**
 * Main dashboard view for the DMW frontend.
 * The component coordinates auth state, device management, and agent demo flows while keeping UI logic compact.
 */
export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [login, setLogin] = useState({ email: '', password: '' })
  const [form, setForm] = useState<DeviceForm>({ name: '', mac_address: '', ip_address: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [createdDevice, setCreatedDevice] = useState<{ pairingCode?: string; deviceId?: number; expiresAt?: string } | null>(null)
  const [historyByDevice, setHistoryByDevice] = useState<Record<number, DeviceHistoryEntry[]>>({})
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [agentState, setAgentState] = useState<AgentState>(DEFAULT_AGENT_STATE)

  const apiBase = getApiBaseUrl()
  const wsBase = getWebSocketBaseUrl()

  /**
   * Load device metadata and alert summaries for the current user.
   */
  const loadDevices = async () => {
    if (!token) return

    const { res, data } = await requestJson(`${apiBase}/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      setMessage('디바이스 목록을 불러오지 못했습니다.')
      return
    }

    setDevices(normalizeDevices(data?.devices ?? []))

    const alertResult = await requestJson(`${apiBase}/alerts`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (alertResult.res.ok) {
      setAlerts(normalizeAlerts(alertResult.data?.alerts ?? []))
    }
  }

  /**
   * Restore the session using the refresh-token cookie when present.
   */
  const refreshSession = async () => {
    try {
      const { res, data } = await requestJson(`${apiBase}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      })

      if (res.ok && data?.accessToken) {
        setToken(data.accessToken)
      }
    } catch {
      // Network error or server unreachable — stay logged out.
    }
  }

  useEffect(() => {
    refreshSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!token) return
    void loadDevices()
  }, [token])

  useEffect(() => {
    if (!token) return

    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null

    const connect = () => {
      // 토큰을 서브프로토콜로 전달해 URL/히스토리/프록시 로그 노출을 차단한다.
      socket = new WebSocket(wsBase, [token])

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'devices-updated' && Array.isArray(payload.devices)) {
            setDevices(normalizeDevices(payload.devices))
          }
        } catch {
          // Ignore malformed WS payloads while the connection is reconnecting.
        }
      }

      socket.onclose = () => {
        if (reconnectTimer) window.clearTimeout(reconnectTimer)
        reconnectTimer = window.setTimeout(connect, 1500)
      }
    }

    connect()
    return () => {
      if (socket) socket.close()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
    }
  }, [token, wsBase])

  /**
   * Authenticate with the admin username and password.
   */
  const loginUser = async () => {
    const { res, data } = await requestJson(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(login),
    })

    if (!res.ok) {
      setMessage(data?.message || '로그인 실패')
      return
    }

    setToken(data.accessToken)
    setMessage('로그인 성공')
  }

  /**
   * Clear local session data and revoke the refresh token on the server when possible.
   */
  const logoutUser = async () => {
    try {
      await requestJson(`${apiBase}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Even if the request fails, clear the local session below.
    }

    setToken('')
    setDevices([])
    setAlerts([])
    setHistoryByDevice({})
    setCreatedDevice(null)
    setEditingId(null)
    setMessage('로그아웃되었습니다.')
  }

  /**
   * Persist a new device and issue a pairing code.
   */
  const saveDevice = async () => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    if (!form.name.trim()) {
      setMessage('디바이스 이름을 입력해 주세요.')
      return
    }
    if (!isValidMac(form.mac_address)) {
      setMessage('MAC 주소 형식이 올바르지 않습니다. (예: AA:BB:CC:DD:EE:FF)')
      return
    }
    if (!isValidIp(form.ip_address)) {
      setMessage('IP 주소 형식이 올바르지 않습니다. (예: 192.168.0.20)')
      return
    }

    const method = editingId !== null ? 'PATCH' : 'POST'
    const endpoint = editingId !== null ? `${apiBase}/devices/${editingId}` : `${apiBase}/devices`

    const { res, data } = await requestJson(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(form),
    })

    if (!res.ok) {
      setMessage(data?.message || '디바이스 저장 실패')
      return
    }

    setMessage(editingId !== null ? '디바이스 수정 완료' : '디바이스 등록 완료')
    setForm({ name: '', mac_address: '', ip_address: '' })
    setEditingId(null)
    if (method === 'POST') {
      setCreatedDevice(data)
    } else {
      setCreatedDevice(null)
    }
    await loadDevices()
  }

  /**
   * Delete a device record and refresh the dashboard.
   * @param {number} id - Device identifier.
   */
  const deleteDevice = async (id: number) => {
    const { res, data } = await requestJson(`${apiBase}/devices/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (res.ok) {
      setMessage(data?.message || '디바이스 삭제 완료')
      await loadDevices()
    }
  }

  /**
   * Populate the device form for editing.
   * @param {Device} device - Current device record.
   */
  const editDevice = (device: Device) => {
    setEditingId(device.id)
    setForm({
      name: device.name,
      mac_address: device.mac_address,
      ip_address: device.ip_address,
    })
  }

  /**
   * Trigger a WOL magic packet for a paired device.
   * @param {number} id - Device identifier.
   */
  const wakeDevice = async (id: number) => {
    const { res, data } = await requestJson(`${apiBase}/devices/${id}/wake`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    setMessage(data?.message || 'Wake 요청 전송')
    if (res.ok) {
      await loadDevices()
    }
  }

  /**
   * Load a device’s recent metric history for chart display.
   * @param {number} deviceId - Device identifier.
   */
  const loadHistory = async (deviceId: number) => {
    const { res, data } = await requestJson(`${apiBase}/devices/${deviceId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      setMessage('히스토리를 불러오지 못했습니다.')
      return
    }

    setHistoryByDevice((prev) => mapHistory(prev, deviceId, data?.history ?? []))
  }

  /**
   * Pair a demo agent by exchanging its pairing code for an API key.
   */
  const pairAgent = async () => {
    const pairingCode = agentState.pairingCode || createdDevice?.pairingCode || ''
    if (!pairingCode) {
      setMessage('페어링 코드를 입력하거나 생성된 코드를 사용하세요.')
      return
    }

    const { res, data } = await requestJson(`${agentState.serverUrl}/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '127.0.0.1', pairingCode }),
    })

    if (!res.ok) {
      setMessage(data?.message || '페어링 실패')
      return
    }

    setAgentState((prev) => ({ ...prev, apiKey: data.apiKey, deviceId: data.deviceId }))
    setMessage(`에이전트 페어링 성공. API Key 발급 완료: ${data.apiKey.slice(0, 10)}...`)
    await loadDevices()
  }

  /**
   * Simulate a heartbeat from the paired agent using the issued API key.
   */
  const sendHeartbeat = async () => {
    if (!agentState.apiKey) {
      setMessage('먼저 에이전트를 페어링해 주세요.')
      return
    }

    const payload = {
      cpuUsage: 31.5,
      memoryUsage: 44.2,
      diskUsage: 58.1,
      deviceId: agentState.deviceId,
    }

    const { res, data } = await requestJson(`${agentState.serverUrl}/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentState.apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      setMessage(data?.message || 'heartbeat 전송 실패')
      return
    }

    setMessage('heartbeat 전송 성공. 상태가 최신화되었습니다.')
    await loadDevices()
  }

  const summary = {
    total: devices.length,
    online: devices.filter((device) => device.status === 'ONLINE').length,
    offline: devices.filter((device) => device.status === 'OFFLINE').length,
    notPaired: devices.filter((device) => !device.agent_paired).length,
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

          <section className="card form-card">
            <h2>{editingId !== null ? '디바이스 수정' : '새 디바이스 등록'}</h2>
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
            {createdDevice && (
              <div className="pairing-box">
                <strong>발급된 페어링 코드</strong>
                <div className="pairing-code">{createdDevice.pairingCode}</div>
                <small>유효시간: {createdDevice.expiresAt ? new Date(createdDevice.expiresAt).toLocaleString() : '10분'}</small>
              </div>
            )}
          </section>

          <section className="card agent-card">
            <h2>Agent 연결 데모</h2>
            <div className="form-grid">
              <label>
                서버 URL
                <input value={agentState.serverUrl} onChange={(e) => setAgentState({ ...agentState, serverUrl: e.target.value })} />
              </label>
              <label>
                페어링 코드
                <input value={agentState.pairingCode || createdDevice?.pairingCode || ''} onChange={(e) => setAgentState({ ...agentState, pairingCode: e.target.value })} />
              </label>
            </div>
            <div className="action-row">
              <button onClick={pairAgent}>에이전트 페어링</button>
              <button className="secondary" onClick={sendHeartbeat}>heartbeat 전송</button>
            </div>
            {agentState.apiKey && (
              <div className="api-box">
                <span>API Key</span>
                <strong>{agentState.apiKey}</strong>
              </div>
            )}
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
