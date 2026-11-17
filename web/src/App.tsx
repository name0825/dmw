import { useMemo, useRef, useState } from 'react'

import { getApiBaseUrl, getWebSocketBaseUrl } from './api'
import SshPanel from './SshPanel'
import { useAuth } from './hooks/useAuth'
import { useDeviceSocket } from './hooks/useDeviceSocket'
import { useDevices } from './hooks/useDevices'
import { METRIC_OPTIONS } from './constants'
import type { Device, DeviceHistoryEntry, MetricKey, PairingInfo } from './types'

const ALERT_PREVIEW_COUNT = 5

type DeviceSortKey = 'name' | 'status' | 'ip' | 'cpu' | 'last_seen'

const DEVICE_SORT_STORAGE_KEY = 'dmw.deviceSort'

const DEVICE_SORT_OPTIONS: { value: DeviceSortKey; label: string }[] = [
  { value: 'name', label: '이름' },
  { value: 'status', label: '상태' },
  { value: 'ip', label: 'IP' },
  { value: 'cpu', label: 'CPU 사용량' },
  { value: 'last_seen', label: '최근 접속' },
]

const loadDeviceSort = (): DeviceSortKey => {
  try {
    const stored = localStorage.getItem(DEVICE_SORT_STORAGE_KEY)
    return DEVICE_SORT_OPTIONS.some((option) => option.value === stored) ? (stored as DeviceSortKey) : 'name'
  } catch {
    return 'name'
  }
}

const parseIp = (ip: string | undefined): number[] | null => {
  const parts = (ip ?? '').trim().split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null
}

const liveUsage = (device: Device, value: number | undefined) => (device.status === 'ONLINE' ? (value ?? 0) : 0)

const ALL_METRIC_KEYS: MetricKey[] = METRIC_OPTIONS.map((option) => option.key)

const isSelected = (device: Device, key: MetricKey) => (device.metric_selection ?? ALL_METRIC_KEYS).includes(key)

const hasValue = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

const formatTemp = (value: number) => `${Math.round(value)}°C`

const formatCpuClock = (mhz: number) => (mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${Math.round(mhz)} MHz`)

const compareName =(a: Device, b: Device) => a.name.localeCompare(b.name, 'ko') || a.id - b.id

const compareDevices = (sortKey: DeviceSortKey) => (a: Device, b: Device): number => {
  switch (sortKey) {
    case 'status': {
      const diff = Number(b.status === 'ONLINE') - Number(a.status === 'ONLINE')
      return diff || compareName(a, b)
    }
    case 'ip': {
      const ipA = parseIp(a.ip_address)
      const ipB = parseIp(b.ip_address)
      if (!ipA || !ipB) return Number(!ipA) - Number(!ipB) || compareName(a, b)
      for (let i = 0; i < 4; i += 1) {
        if (ipA[i] !== ipB[i]) return ipA[i] - ipB[i]
      }
      return compareName(a, b)
    }
    case 'cpu': {
      const cpuA = a.status === 'ONLINE' ? a.cpu_usage : undefined
      const cpuB = b.status === 'ONLINE' ? b.cpu_usage : undefined
      if (cpuA === undefined || cpuA === null || cpuB === undefined || cpuB === null) {
        return Number(cpuA === undefined || cpuA === null) - Number(cpuB === undefined || cpuB === null) || compareName(a, b)
      }
      return cpuB - cpuA || compareName(a, b)
    }
    case 'last_seen': {
      const timeA = a.last_seen ? new Date(a.last_seen).getTime() : NaN
      const timeB = b.last_seen ? new Date(b.last_seen).getTime() : NaN
      if (Number.isNaN(timeA) || Number.isNaN(timeB)) return Number(Number.isNaN(timeA)) - Number(Number.isNaN(timeB)) || compareName(a, b)
      return timeB - timeA || compareName(a, b)
    }
    default:
      return compareName(a, b)
  }
}

/**
 * Main dashboard view for the DMW frontend.
 * The component coordinates auth state, device management, and pairing code issuance while keeping UI logic compact.
 */
export default function App() {
  const [message, setMessage] = useState('')
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null)
  const [sshOpenId, setSshOpenId] = useState<number | null>(null)
  const [alertsExpanded, setAlertsExpanded] = useState(false)
  const [metricOpenId, setMetricOpenId] = useState<number | null>(null)

  const apiBase = getApiBaseUrl()
  const wsBase = getWebSocketBaseUrl()

  const resetDevicesRef = useRef<() => void>(() => {})

  const { login, setLogin, token, refreshSession, authedRequest, loginUser, loggingIn, logoutUser } = useAuth(
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
    saving,
    deleteDevice,
    editDevice,
    wakeDevice,
    pendingIds,
    loadHistory,
    saveMetricSelection,
    summary,
  } = useDevices(apiBase, token, authedRequest, setMessage)

  resetDevicesRef.current = resetDevices

  const [deviceSort, setDeviceSort] = useState<DeviceSortKey>(loadDeviceSort)
  const sortedDevices = useMemo(() => [...devices].sort(compareDevices(deviceSort)), [devices, deviceSort])

  const changeDeviceSort = (value: DeviceSortKey) => {
    setDeviceSort(value)
    try {
      localStorage.setItem(DEVICE_SORT_STORAGE_KEY, value)
    } catch {
      return
    }
  }

  useDeviceSocket(token, wsBase, refreshSession, logoutUser, setDevices)

  /**
   * Issue a pairing code that is not yet bound to any device.
   */
  const generatePairingCode = async () => {
    if (!token) {
      setMessage('먼저 로그인해야 합니다.')
      return
    }

    try {
      const { res, data } = await authedRequest(`${apiBase}/pairing-codes`, { method: 'POST' })

      if (!res.ok) {
        setMessage(data?.message || '페어링 코드 발급 실패')
        return
      }

      setPairingInfo({ code: data.code, expiresAt: data.expiresAt })
      setMessage('페어링 코드가 발급되었습니다.')
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    }
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

    try {
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
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    }
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
   * Toggle one metric in a device's collection selection and persist it.
   * @param {Device} device - Target device.
   * @param {MetricKey} key - Metric to toggle.
   */
  const toggleMetric = (device: Device, key: MetricKey) => {
    const current = device.metric_selection ?? ALL_METRIC_KEYS
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    void saveMetricSelection(device.id, ALL_METRIC_KEYS.filter((item) => next.includes(item)))
  }

  /**
   * Render the usage meters and temperature/clock chips for the metrics selected on a device.
   * @param {Device} device - Device to render.
   * @returns {JSX.Element} Metric block.
   */
  const renderMetrics = (device: Device) => {
    const online = device.status === 'ONLINE'
    const disks = online ? (device.disks ?? []) : []
    const usageDisks = disks.filter((disk) => hasValue(disk.usage))
    const tempDisks = disks.filter((disk) => hasValue(disk.tempC))
    const showDiskTemp = isSelected(device, 'disk_temp')

    const chips: string[] = []
    if (online) {
      if (isSelected(device, 'cpu_temp') && hasValue(device.cpu_temp)) chips.push(`CPU ${formatTemp(device.cpu_temp)}`)
      if (isSelected(device, 'memory_temp') && hasValue(device.memory_temp)) chips.push(`MEM ${formatTemp(device.memory_temp)}`)
      if (isSelected(device, 'cpu_clock') && hasValue(device.cpu_clock)) chips.push(`CPU ${formatCpuClock(device.cpu_clock)}`)
      if (isSelected(device, 'memory_clock') && hasValue(device.memory_clock)) chips.push(`MEM ${Math.round(device.memory_clock)} MT/s`)
    }

    return (
      <div className="metric-stack">
        {isSelected(device, 'cpu_usage') && (
          <div>
            <label>CPU</label>
            <div className="meter"><span style={{ width: `${Math.min(liveUsage(device, device.cpu_usage), 100)}%` }} /></div>
            <small>{liveUsage(device, device.cpu_usage)}%</small>
          </div>
        )}
        {isSelected(device, 'memory_usage') && (
          <div>
            <label>MEM</label>
            <div className="meter"><span style={{ width: `${Math.min(liveUsage(device, device.memory_usage), 100)}%` }} /></div>
            <small>{liveUsage(device, device.memory_usage)}%</small>
          </div>
        )}
        {isSelected(device, 'disk_usage') && (usageDisks.length > 0 ? (
          usageDisks.map((disk) => (
            <div key={disk.name}>
              <label>DISK {disk.name}</label>
              <div className="meter"><span style={{ width: `${Math.min(disk.usage ?? 0, 100)}%` }} /></div>
              <small>{disk.usage}%{showDiskTemp && hasValue(disk.tempC) ? ` · ${formatTemp(disk.tempC)}` : ''}</small>
            </div>
          ))
        ) : (
          <div>
            <label>DISK</label>
            <div className="meter"><span style={{ width: `${Math.min(liveUsage(device, device.disk_usage), 100)}%` }} /></div>
            <small>{liveUsage(device, device.disk_usage)}%</small>
          </div>
        ))}
        {!isSelected(device, 'disk_usage') && showDiskTemp && tempDisks.map((disk) => (
          <div key={disk.name}>
            <label>DISK {disk.name}</label>
            <small>{formatTemp(disk.tempC as number)}</small>
          </div>
        ))}
        {chips.length > 0 && (
          <div className="metric-chips">
            {chips.map((chip) => <span key={chip} className="metric-chip">{chip}</span>)}
          </div>
        )}
      </div>
    )
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
          <button onClick={loginUser} disabled={loggingIn}>로그인</button>
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
          <button onClick={loginUser} disabled={loggingIn}>로그인</button>
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
              <h2>경고 ({alerts.length})</h2>
              <div className="alert-list">
                {(alertsExpanded ? alerts : alerts.slice(0, ALERT_PREVIEW_COUNT)).map((alert, idx) => (
                  <div key={alert.id ?? `${alert.deviceId}-${idx}`} className={`alert-item ${alert.level}`}>
                    <div>
                      <strong>{alert.deviceName ?? devices.find((d) => d.id === alert.deviceId)?.name ?? `#${alert.deviceId}`}</strong>
                      <p>{alert.message}</p>
                      {alert.createdAt && !Number.isNaN(Date.parse(alert.createdAt)) && <small>{new Date(alert.createdAt).toLocaleString()}</small>}
                    </div>
                    <span>{alert.metric === 'offline' ? 'OFFLINE' : `${alert.metric.toUpperCase()} ${alert.value}%`}</span>
                  </div>
                ))}
              </div>
              {alerts.length > ALERT_PREVIEW_COUNT && (
                <button className="secondary" onClick={() => setAlertsExpanded(!alertsExpanded)}>
                  {alertsExpanded ? '접기' : `더 보기 (${alerts.length - ALERT_PREVIEW_COUNT}개 더)`}
                </button>
              )}
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
              <button onClick={saveDevice} disabled={saving}>{editingId !== null ? '저장' : '디바이스 등록'}</button>
              {editingId !== null && (
                <button className="secondary" onClick={() => {
                  setEditingId(null)
                  setForm({ name: '', mac_address: '', ip_address: '' })
                }}>취소</button>
              )}
            </div>
          </section>

          <section className="card status-panel">
            <div className="panel-header">
              <h2>디바이스 상태</h2>
              <select value={deviceSort} onChange={(e) => changeDeviceSort(e.target.value as DeviceSortKey)} aria-label="디바이스 정렬">
                {DEVICE_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            {message && <p className="message">{message}</p>}
            <div className="device-list">
              {devices.length === 0 ? (
                <p>등록된 디바이스가 없습니다.</p>
              ) : (
                sortedDevices.map((device) => (
                  <div className="device-item" key={device.id}>
                    <div>
                      <h3>{device.name}</h3>
                      <p>{device.ip_address} · {device.mac_address}</p>
                      <small>{device.last_seen ? `Last seen: ${new Date(device.last_seen).toLocaleString()}` : 'Heartbeat 없음'}</small>
                      {renderMetrics(device)}
                    </div>
                    <div className="device-meta">
                      <span className={`badge ${String(device.status).toLowerCase()}`}>{device.status}</span>
                      <span>{device.agent_paired ? 'Paired' : 'Not Paired'}</span>
                      {device.agent_version && <span>에이전트 v{device.agent_version}</span>}
                    </div>
                    <div className="device-actions">
                      <button onClick={() => editDevice(device)}>수정</button>
                      <button className="secondary" onClick={() => deleteDevice(device.id)} disabled={pendingIds.has(device.id)}>삭제</button>
                      <button onClick={() => wakeDevice(device.id)} disabled={pendingIds.has(device.id)}>Wake</button>
                      <button className="secondary" onClick={() => loadHistory(device.id)}>History</button>
                      <button className="secondary" onClick={() => setSshOpenId(sshOpenId === device.id ? null : device.id)}>SSH</button>
                      <button className="secondary" onClick={() => setMetricOpenId(metricOpenId === device.id ? null : device.id)}>수집 항목</button>
                      {device.agent_paired && (
                        <button className="secondary" onClick={() => generateRepairingCode(device)}>재페어링 코드</button>
                      )}
                    </div>
                    {metricOpenId === device.id && (
                      <div className="metric-select">
                        {METRIC_OPTIONS.map((option) => (
                          <label key={option.key}>
                            <input
                              type="checkbox"
                              checked={isSelected(device, option.key)}
                              disabled={pendingIds.has(device.id)}
                              onChange={() => toggleMetric(device, option.key)}
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    )}
                    {historyByDevice[device.id]?.length ? (
                      <div className="history-panel">
                        <strong>최근 메트릭</strong>
                        <div className="chart-row">
                          {isSelected(device, 'cpu_usage') && (
                            <div className="chart-box cpu">
                              <span>CPU</span>
                              {renderTrendChart(historyByDevice[device.id], 'cpu_usage')}
                            </div>
                          )}
                          {isSelected(device, 'memory_usage') && (
                            <div className="chart-box mem">
                              <span>MEM</span>
                              {renderTrendChart(historyByDevice[device.id], 'memory_usage')}
                            </div>
                          )}
                          {isSelected(device, 'disk_usage') && (
                            <div className="chart-box disk">
                              <span>DISK</span>
                              {renderTrendChart(historyByDevice[device.id], 'disk_usage')}
                            </div>
                          )}
                        </div>
                        {historyByDevice[device.id].slice(0, 5).map((entry) => (
                          <div key={`${device.id}-${entry.timestamp}`} className="history-item">
                            <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                            {isSelected(device, 'cpu_usage') && <small>CPU {entry.cpu_usage ?? 0}%</small>}
                            {isSelected(device, 'memory_usage') && <small>MEM {entry.memory_usage ?? 0}%</small>}
                            {isSelected(device, 'disk_usage') && <small>DISK {entry.disk_usage ?? 0}%</small>}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {sshOpenId === device.id && (
                      <SshPanel device={device} apiBase={apiBase} authedRequest={authedRequest} />
                    )}
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
