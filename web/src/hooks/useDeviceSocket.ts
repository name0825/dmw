import { useEffect } from 'react'

import { normalizeDevices } from '../api'
import type { Device } from '../types'
import type { RefreshResult } from './useAuth'

export const useDeviceSocket = (
  token: string,
  wsBase: string,
  refreshSession: () => Promise<RefreshResult>,
  logoutUser: () => Promise<void>,
  setDevices: (devices: Device[]) => void,
) => {
  useEffect(() => {
    if (!token) return

    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let cancelled = false
    let attempt = 0
    let quickFailCount = 0
    let connectStartedAt = 0

    const BASE_BACKOFF_MS = 1500
    const MAX_BACKOFF_MS = 30000
    // 연결 시도 직후(1초 이내) 닫히는 패턴이 반복되면 핸드셰이크 인증 실패(401)로 간주한다.
    const QUICK_FAIL_MS = 1000

    const backoffDelay = () => {
      const cap = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
      return cap / 2 + Math.random() * (cap / 2)
    }

    const scheduleReconnect = () => {
      const delay = backoffDelay()
      attempt += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }

    const connect = () => {
      connectStartedAt = Date.now()
      // 토큰을 서브프로토콜로 전달해 URL/히스토리/프록시 로그 노출을 차단한다.
      socket = new WebSocket(wsBase, [token])

      socket.onopen = () => {
        attempt = 0
        quickFailCount = 0
      }

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

      socket.onclose = async () => {
        if (cancelled) return

        quickFailCount = Date.now() - connectStartedAt < QUICK_FAIL_MS ? quickFailCount + 1 : 0

        if (quickFailCount >= 2) {
          const result = await refreshSession()
          if (cancelled) return

          if (result.status === 'auth-failed') {
            await logoutUser()
            // token 상태 변화(로그아웃)가 이 effect 를 재실행시키므로 여기서는 재연결을 예약하지 않는다.
            return
          }

          if (result.status === 'network-error') {
            // 토큰과 무관한 장애이므로 세션을 유지하고 백오프로 계속 재시도한다.
            scheduleReconnect()
            return
          }

          // token 상태 변화(갱신)가 이 effect 를 재실행시키므로 여기서는 재연결을 예약하지 않는다.
          return
        }

        scheduleReconnect()
      }
    }

    connect()
    return () => {
      cancelled = true
      if (socket) socket.close()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
    }
  }, [token, wsBase])
}
