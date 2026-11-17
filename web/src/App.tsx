import { useEffect, useMemo, useRef, useState } from 'react'

import { getApiBaseUrl, getWebSocketBaseUrl } from './api'
import SshPanel from './SshPanel'
import { useAuth } from './hooks/useAuth'
import { useDeviceSocket } from './hooks/useDeviceSocket'
import { useAgentRelease } from './hooks/useAgentRelease'
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

const UPDATE_STATE_LABELS: Record<string, string> = {
  requested: '업데이트 요청됨',
  delivered: '전달됨',
  installing: '설치 중',
  updated: '업데이트 완료',
  up_to_date: '최신 버전',
  failed: '업데이트 실패',
}

const isNewerVersion = (candidate: string, current: string) => {
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

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

const formatRelativeTime = (iso: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (Number.isNaN(seconds) || seconds < 60) return '방금 전'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

const meterLevel = (value: number) => (value >= 90 ? ' danger' : value >= 80 ? ' warning' : '')

const STATUS_LABELS: Record<string, string> = { ONLINE: '온라인', OFFLINE: '오프라인', NOT_PAIRED: '미페어링' }

const statusLabel = (status: string) => STATUS_LABELS[status] ?? status

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
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)

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
    requestAgentUpdate,
    pendingIds,
    loadHistory,
    saveMetricSelection,
    summary,
  } = useDevices(apiBase, token, authedRequest, setMessage)

  const { release, checking, checkRelease } = useAgentRelease(apiBase, token, authedRequest, setMessage)
  const latestVersion = release?.version ?? null

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

  const formCardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(() => setMessage(''), 4000)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (editingId !== null) formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [editingId])

  useEffect(() => {
    if (menuOpenId === null) return undefined
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.overflow-menu')) setMenuOpenId(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpenId(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpenId])

  const confirmDelete = (device: Device) => {
    if (window.confirm(`'${device.name}' 디바이스를 삭제할까요?`)) void deleteDevice(device.id)
  }

  const confirmAgentUpdate = (device: Device) => {
    if (window.confirm(`'${device.name}' 에이전트를 최신 버전으로 업데이트할까요? 업데이트 후 에이전트가 다시 시작됩니다.`)) {
      void requestAgentUpdate(device.id)
    }
  }

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
        <div className="metric-grid">
          {isSelected(device, 'cpu_usage') && (
            <div className="metric-item">
              <div className="metric-line">
                <label>CPU</label>
                <small>{liveUsage(device, device.cpu_usage)}%</small>
              </div>
              <div className="meter"><span className={meterLevel(liveUsage(device, device.cpu_usage))} style={{ width: `${Math.min(liveUsage(device, device.cpu_usage), 100)}%` }} /></div>
            </div>
          )}
          {isSelected(device, 'memory_usage') && (
            <div className="metric-item">
              <div className="metric-line">
                <label>MEM</label>
                <small>{liveUsage(device, device.memory_usage)}%</small>
              </div>
              <div className="meter"><span className={meterLevel(liveUsage(device, device.memory_usage))} style={{ width: `${Math.min(liveUsage(device, device.memory_usage), 100)}%` }} /></div>
            </div>
          )}
          {isSelected(device, 'disk_usage') && (usageDisks.length > 0 ? (
            usageDisks.map((disk) => (
              <div className="metric-item" key={disk.name}>
                <div className="metric-line">
                  <label>DISK {disk.name}</label>
                  <small>{disk.usage}%{showDiskTemp && hasValue(disk.tempC) ? ` · ${formatTemp(disk.tempC)}` : ''}</small>
                </div>
                <div className="meter"><span className={meterLevel(disk.usage ?? 0)} style={{ width: `${Math.min(disk.usage ?? 0, 100)}%` }} /></div>
              </div>
            ))
          ) : (
            <div className="metric-item">
              <div className="metric-line">
                <label>DISK</label>
                <small>{liveUsage(device, device.disk_usage)}%</small>
              </div>
              <div className="meter"><span className={meterLevel(liveUsage(device, device.disk_usage))} style={{ width: `${Math.min(liveUsage(device, device.disk_usage), 100)}%` }} /></div>
            </div>
          ))}
          {!isSelected(device, 'disk_usage') && showDiskTemp && tempDisks.map((disk) => (
            <div className="metric-item" key={disk.name}>
              <div className="metric-line">
                <label>DISK {disk.name}</label>
                <small>{formatTemp(disk.tempC as number)}</small>
              </div>
            </div>
          ))}
        </div>
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
        {token && <button className="secondary" onClick={logoutUser}>로그아웃</button>}
      </header>

      {message && (
        <div className="toast" role="status" aria-live="polite">
          <span>{message}</span>
          <button className="toast-close" aria-label="알림 닫기" onClick={() => setMessage('')}>×</button>
        </div>
      )}

      {!token ? (
        <form
          className="card auth-card"
          onSubmit={(e) => {
            e.preventDefault()
            loginUser()
          }}
        >
          <h2>관리자 로그인</h2>
          <label>
            이메일
            <input
              type="email"
              autoComplete="username"
              autoFocus
              value={login.email}
              onChange={(e) => setLogin({ ...login, email: e.target.value })}
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              autoComplete="current-password"
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
            />
          </label>
          <button type="submit" disabled={loggingIn}>로그인</button>
        </form>
      ) : (
        <>
          <section className="card overview-panel">
            <h2>요약</h2>
            <div className="summary-grid">
              <div className="summary-card">
                <span>전체</span>
                <strong>{summary.total}</strong>
              </div>
              <div className="summary-card success">
                <span>온라인</span>
                <strong>{summary.online}</strong>
              </div>
              <div className="summary-card danger">
                <span>오프라인</span>
                <strong>{summary.offline}</strong>
              </div>
              <div className="summary-card warning">
                <span>미페어링</span>
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

          <section className="card status-panel">
            <div className="panel-header">
              <h2>디바이스 상태</h2>
              <div className="release-check">
                {release && (
                  <span className="release-info" title={release.error || undefined}>
                    {latestVersion ? `최신 에이전트 v${latestVersion}` : '최신 버전 확인 실패'}
                  </span>
                )}
                <button className="secondary" onClick={() => void checkRelease(true)} disabled={checking}>업데이트 확인</button>
              </div>
              <label className="sort-control">
                <span>정렬</span>
                <select value={deviceSort} onChange={(e) => changeDeviceSort(e.target.value as DeviceSortKey)}>
                  {DEVICE_SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="device-list">
              {devices.length === 0 ? (
                <div className="empty-state">
                  <strong>등록된 디바이스가 없습니다</strong>
                  <p>아래 '디바이스 추가'에서 페어링 코드를 발급하거나 수동 등록하세요.</p>
                </div>
              ) : (
                sortedDevices.map((device) => (
                  <div
                    className={`device-item${sshOpenId === device.id || historyByDevice[device.id]?.length ? ' wide' : ''}`}
                    key={device.id}
                  >
                    <div className="device-header">
                      <div className="device-title">
                        <h3 title={device.name}>{device.name}</h3>
                        <span className={`badge ${String(device.status).toLowerCase()}`}>{statusLabel(device.status)}</span>
                        {device.status !== 'NOT_PAIRED' && <span className="device-chip">{device.agent_paired ? '페어링됨' : '미페어링'}</span>}
                        {device.agent_version && <span className="device-chip">v{device.agent_version}</span>}
                        {device.agent_version && latestVersion && isNewerVersion(latestVersion, device.agent_version) && (
                          <span className="device-chip update-available">업데이트 가능 → v{latestVersion}</span>
                        )}
                        {device.update_state && UPDATE_STATE_LABELS[device.update_state] && (
                          <span
                            className={`device-chip update-state ${device.update_state}`}
                            title={device.update_message || undefined}
                          >{UPDATE_STATE_LABELS[device.update_state]}</span>
                        )}
                      </div>
                      <div className="device-actions">
                        <button
                          className={device.status === 'ONLINE' ? 'secondary' : undefined}
                          onClick={() => wakeDevice(device.id)}
                          disabled={pendingIds.has(device.id)}
                        >깨우기</button>
                        <button className="secondary" onClick={() => loadHistory(device.id)}>기록</button>
                        <button
                          className={`secondary${sshOpenId === device.id ? ' active' : ''}`}
                          aria-pressed={sshOpenId === device.id}
                          onClick={() => setSshOpenId(sshOpenId === device.id ? null : device.id)}
                        >SSH</button>
                        <div className="overflow-menu">
                          <button
                            className="secondary overflow-toggle"
                            aria-label="더 보기"
                            aria-haspopup="menu"
                            aria-expanded={menuOpenId === device.id}
                            onClick={() => setMenuOpenId(menuOpenId === device.id ? null : device.id)}
                          >⋯</button>
                          {menuOpenId === device.id && (
                            <div className="overflow-dropdown" role="menu">
                              <button
                                role="menuitem"
                                className={metricOpenId === device.id ? 'active' : undefined}
                                aria-pressed={metricOpenId === device.id}
                                onClick={() => {
                                  setMetricOpenId(metricOpenId === device.id ? null : device.id)
                                  setMenuOpenId(null)
                                }}
                              >수집 항목</button>
                              {!!device.agent_paired && (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    setMenuOpenId(null)
                                    void generateRepairingCode(device)
                                  }}
                                >재페어링 코드</button>
                              )}
                              {!!device.agent_paired && (
                                <button
                                  role="menuitem"
                                  disabled={device.status !== 'ONLINE' || pendingIds.has(device.id)}
                                  onClick={() => {
                                    setMenuOpenId(null)
                                    confirmAgentUpdate(device)
                                  }}
                                >에이전트 업데이트</button>
                              )}
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setMenuOpenId(null)
                                  editDevice(device)
                                }}
                              >수정</button>
                              <button
                                role="menuitem"
                                className="danger"
                                disabled={pendingIds.has(device.id)}
                                onClick={() => {
                                  setMenuOpenId(null)
                                  confirmDelete(device)
                                }}
                              >삭제</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <p className="device-sub">
                      {device.ip_address} · {device.mac_address} · {device.last_seen ? (
                        <span title={new Date(device.last_seen).toLocaleString()}>마지막 응답 {formatRelativeTime(device.last_seen)}</span>
                      ) : '응답 기록 없음'}
                    </p>
                    {device.agent_paired ? renderMetrics(device) : null}
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

          <section className="add-section">
          <h2>디바이스 추가</h2>
          <div className="add-grid">
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

          <section className="card form-card" ref={formCardRef}>
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
          </div>
          </section>
        </>
      )}
    </div>
  )
}
