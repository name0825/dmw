import { useEffect, useRef, useState } from 'react'

import { mapHistory, normalizeAlerts, normalizeDevices } from '../api'
import { IPV4_RE, MAC_RE } from '../constants'
import type { AlertItem, Device, DeviceForm, DeviceHistoryEntry, MetricKey } from '../types'

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

export const useDevices = (
  apiBase: string,
  token: string,
  authedRequest: (url: string, init?: RequestInit) => Promise<{ res: Response; data: any }>,
  setMessage: (message: string) => void,
) => {
  const [devices, setDevicesState] = useState<Device[]>([])
  const socketUpdateRef = useRef(0)
  const setDevices = (next: Device[]) => {
    socketUpdateRef.current += 1
    setDevicesState(next)
  }
  const [form, setForm] = useState<DeviceForm>({ name: '', mac_address: '', ip_address: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [historyByDevice, setHistoryByDevice] = useState<Record<number, DeviceHistoryEntry[]>>({})
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const sessionRef = useRef(0)
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const pendingIdsRef = useRef<Set<number>>(new Set())
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set())

  const resetDevices = () => {
    sessionRef.current += 1
    setDevicesState([])
    setAlerts([])
    setHistoryByDevice({})
    setEditingId(null)
  }

  /**
   * Load device metadata and alert summaries for the current user.
   */
  const loadDevices = async () => {
    if (!token) return

    const session = sessionRef.current
    const socketUpdate = socketUpdateRef.current

    try {
      const { res, data } = await authedRequest(`${apiBase}/devices`)

      if (session !== sessionRef.current) return

      if (!res.ok) {
        setMessage('디바이스 목록을 불러오지 못했습니다.')
        return
      }

      if (socketUpdate === socketUpdateRef.current) {
        setDevicesState(normalizeDevices(data?.devices ?? []))
      }

      const alertResult = await authedRequest(`${apiBase}/alerts`)

      if (session !== sessionRef.current) return

      if (alertResult.res.ok) {
        setAlerts(normalizeAlerts(alertResult.data?.alerts ?? []))
      }
    } catch {
      if (session !== sessionRef.current) return
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    }
  }

  useEffect(() => {
    if (!token) return
    void loadDevices()
  }, [token])

  /**
   * Persist a new device record for WOL-only management.
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

    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)

    const method = editingId !== null ? 'PATCH' : 'POST'
    const endpoint = editingId !== null ? `${apiBase}/devices/${editingId}` : `${apiBase}/devices`

    try {
      const { res, data } = await authedRequest(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      if (!res.ok) {
        setMessage(data?.message || '디바이스 저장 실패')
        return
      }

      setMessage(editingId !== null ? '디바이스 수정 완료' : '디바이스 등록 완료')
      setForm({ name: '', mac_address: '', ip_address: '' })
      setEditingId(null)
      await loadDevices()
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  /**
   * Delete a device record and refresh the dashboard.
   * @param {number} id - Device identifier.
   */
  const deleteDevice = async (id: number) => {
    if (pendingIdsRef.current.has(id)) return
    pendingIdsRef.current.add(id)
    setPendingIds(new Set(pendingIdsRef.current))

    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${id}`, { method: 'DELETE' })

      if (res.ok) {
        setMessage(data?.message || '디바이스 삭제 완료')
        await loadDevices()
      } else {
        setMessage(data?.message || '삭제 실패')
      }
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      pendingIdsRef.current.delete(id)
      setPendingIds(new Set(pendingIdsRef.current))
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
    if (pendingIdsRef.current.has(id)) return
    pendingIdsRef.current.add(id)
    setPendingIds(new Set(pendingIdsRef.current))

    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${id}/wake`, { method: 'POST' })

      if (res.ok && data?.agentPaired === false) {
        setMessage('WOL 신호는 보냈지만 Agent가 설치/페어링되지 않아 전원 상태를 확인할 수 없습니다.')
      } else {
        setMessage(data?.message || 'Wake 요청 전송')
      }
      if (res.ok) {
        await loadDevices()
      }
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      pendingIdsRef.current.delete(id)
      setPendingIds(new Set(pendingIdsRef.current))
    }
  }

  /**
   * Ask the agent of a paired device to install the latest release.
   * @param {number} id - Device identifier.
   */
  const requestAgentUpdate = async (id: number) => {
    if (pendingIdsRef.current.has(id)) return
    pendingIdsRef.current.add(id)
    setPendingIds(new Set(pendingIdsRef.current))

    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${id}/agent-update`, { method: 'POST' })

      if (!res.ok) {
        setMessage(data?.message || '에이전트 업데이트 요청 실패')
        return
      }

      setMessage('에이전트 업데이트를 요청했습니다.')
      await loadDevices()
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      pendingIdsRef.current.delete(id)
      setPendingIds(new Set(pendingIdsRef.current))
    }
  }

  /**
   * Save which metrics the agent of a device should collect and display.
   * @param {number} id - Device identifier.
   * @param {MetricKey[]} metrics - Selected metric keys.
   */
  const saveMetricSelection = async (id: number, metrics: MetricKey[]) => {
    if (pendingIdsRef.current.has(id)) return
    pendingIdsRef.current.add(id)
    setPendingIds(new Set(pendingIdsRef.current))

    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${id}/metric-selection`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics }),
      })

      if (!res.ok) {
        setMessage(data?.message || '수집 항목 저장 실패')
        return
      }

      await loadDevices()
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      pendingIdsRef.current.delete(id)
      setPendingIds(new Set(pendingIdsRef.current))
    }
  }

  /**
   * Load a device’s recent metric history for chart display.
   * @param {number} deviceId - Device identifier.
   */
  const loadHistory = async (deviceId: number) => {
    try {
      const { res, data } = await authedRequest(`${apiBase}/devices/${deviceId}/history`)

      if (!res.ok) {
        setMessage('히스토리를 불러오지 못했습니다.')
        return
      }

      setHistoryByDevice((prev) => mapHistory(prev, deviceId, data?.history ?? []))
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    }
  }

  const summary = {
    total: devices.length,
    online: devices.filter((device) => device.status === 'ONLINE').length,
    offline: devices.filter((device) => device.status === 'OFFLINE').length,
    notPaired: devices.filter((device) => !device.agent_paired).length,
  }

  return {
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
  }
}
