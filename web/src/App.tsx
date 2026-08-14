import { useEffect, useState } from 'react'

type Device = {
  id: number
  name: string
  mac_address: string
  ip_address: string
  status: string
  agent_paired: boolean
  last_seen?: string
  cpu_usage?: number
  memory_usage?: number
  disk_usage?: number
}

type DeviceForm = {
  name: string
  mac_address: string
  ip_address: string
}

export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [login, setLogin] = useState({ email: '', password: '' })
  const [form, setForm] = useState<DeviceForm>({ name: '', mac_address: '', ip_address: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [createdDevice, setCreatedDevice] = useState<{ pairingCode?: string; deviceId?: number; expiresAt?: string } | null>(null)
  const [historyByDevice, setHistoryByDevice] = useState<Record<number, Array<{ timestamp: string; cpu_usage: number; memory_usage: number; disk_usage: number }>>>({})
  const [alerts, setAlerts] = useState<Array<{ deviceId: number; level: string; message: string; metric: string; value: number }>>([])
  const [agentState, setAgentState] = useState({
    serverUrl: import.meta.env.VITE_API_BASE || 'http://localhost:3001',
    pairingCode: '',
    apiKey: '',
    deviceId: null as number | null,
  })

  const apiBase = (import.meta.env.VITE_API_BASE || 'http://localhost:3001').replace(/\/$/, '')
  const wsBase = (
    import.meta.env.VITE_WS_BASE ||
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
  ).replace(/\/$/, '')

  const loadDevices = async () => {
    if (!token) return

    const res = await fetch(`${apiBase || ''}/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      setMessage('디바이스 목록을 불러오지 못했습니다.')
      return
    }

    const data = await res.json()
    setDevices((data.devices ?? []).map((device: Device) => ({
      ...device,
      cpu_usage: Number(device.cpu_usage ?? 0),
      memory_usage: Number(device.memory_usage ?? 0),
      disk_usage: Number(device.disk_usage ?? 0),
    })))

    const alertRes = await fetch(`${apiBase || ''}/alerts`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (alertRes.ok) {
      const alertData = await alertRes.json()
      setAlerts(alertData.alerts ?? [])
    }
  }

  useEffect(() => {
    if (token) {
      loadDevices()
    }
  }, [token])

  useEffect(() => {
    if (!token) return

    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null

    const connect = () => {
      socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`)

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'devices-updated' && Array.isArray(payload.devices)) {
            setDevices(payload.devices)
          }
        } catch {
          // ignore parse errors
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

  const loginUser = async () => {
    const res = await fetch(`${apiBase || ''}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(login),
    })

    const data = await res.json()
    if (!res.ok) {
      setMessage(data.message || '로그인 실패')
      return
    }

    setToken(data.accessToken)
    setMessage('로그인 성공')
  }

  const createDevice = async () => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    const res = await fetch(`${apiBase}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(form),
    })

    const data = await res.json()
    if (!res.ok) {
      setMessage(data.message || '디바이스 등록 실패')
      return
    }

    setCreatedDevice(data)
    setMessage(`디바이스 등록 완료. 페어링 코드: ${data.pairingCode}`)
    setForm({ name: '', mac_address: '', ip_address: '' })
    await loadDevices()
  }

  const saveDevice = async () => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    const method = editingId !== null ? 'PATCH' : 'POST'
    const endpoint = editingId !== null ? `${apiBase || ''}/devices/${editingId}` : `${apiBase || ''}/devices`

    const res = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(form),
    })

    const data = await res.json()
    if (!res.ok) {
      setMessage(data.message || '디바이스 저장 실패')
      return
    }

    setMessage(editingId !== null ? '디바이스 수정 완료' : '디바이스 등록 완료')
    setForm({ name: '', mac_address: '', ip_address: '' })
    setEditingId(null)
    setCreatedDevice(null)
    await loadDevices()
  }

  const deleteDevice = async (id: number) => {
    const res = await fetch(`${apiBase || ''}/devices/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    const data = await res.json()
    setMessage(data.message || '디바이스 삭제 완료')
    await loadDevices()
  }

  const editDevice = (device: Device) => {
    setEditingId(device.id)
    setForm({
      name: device.name,
      mac_address: device.mac_address,
      ip_address: device.ip_address,
    })
  }

  const wakeDevice = async (id: number) => {
    const res = await fetch(`${apiBase || ''}/devices/${id}/wake`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    const data = await res.json()
    setMessage(data.message || 'Wake 요청 전송')
    if (res.ok) {
      await loadDevices()
    }
  }

  const loadHistory = async (deviceId: number) => {
    const res = await fetch(`${apiBase || ''}/devices/${deviceId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      setMessage('히스토리를 불러오지 못했습니다.')
      return
    }

    const data = await res.json()
    setHistoryByDevice((prev) => ({
      ...prev,
      [deviceId]: data.history ?? [],
    }))
  }

  const pairAgent = async () => {
    const pairingCode = agentState.pairingCode || createdDevice?.pairingCode || ''
    if (!pairingCode) {
      setMessage('페어링 코드를 입력하거나 생성된 코드를 사용하세요.')
      return
    }

    const res = await fetch(`${agentState.serverUrl || ''}/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '127.0.0.1', pairingCode }),
    })

    const data = await res.json()
    if (!res.ok) {
      setMessage(data.message || '페어링 실패')
      return
    }

    setAgentState((prev) => ({ ...prev, apiKey: data.apiKey, deviceId: data.deviceId }))
    setMessage(`에이전트 페어링 성공. API Key 발급 완료: ${data.apiKey.slice(0, 10)}...`)
    await loadDevices()
  }

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

    const res = await fetch(`${agentState.serverUrl || ''}/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentState.apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    if (!res.ok) {
      setMessage(data.message || 'heartbeat 전송 실패')
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

  const renderTrendChart = (
    history: Array<{ timestamp: string; cpu_usage: number; memory_usage: number; disk_usage: number }>,
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
          <button onClick={() => setToken('')}>로그아웃</button>
        ) : (
          <button onClick={loginUser}>로그인</button>
        )}
      </header>

      {!token ? (
        <section className="card auth-card">
          <h2>관리자 로그인</h2>
          <label>
            이메일
            <input
              value={login.email}
              onChange={(e) => setLogin({ ...login, email: e.target.value })}
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
            />
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
                      <span className={`badge ${String(device.status).toLowerCase()}`}>
                        {device.status}
                      </span>
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
