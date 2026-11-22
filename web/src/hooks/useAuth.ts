import { useCallback, useEffect, useRef, useState } from 'react'

import { authorizedRequest, requestJson } from '../api'

/**
 * Outcome of a session refresh attempt, distinguishing an auth failure
 * (refresh token invalid/expired) from a network error (server unreachable).
 */
export type RefreshResult =
  | { status: 'ok'; token: string }
  | { status: 'auth-failed' }
  | { status: 'network-error' }

export const useAuth = (
  apiBase: string,
  setMessage: (message: string) => void,
  onSessionCleared: () => void,
) => {
  const [login, setLogin] = useState({ email: '', password: '' })
  const [token, setToken] = useState('')
  const loggingInRef = useRef(false)
  const [loggingIn, setLoggingIn] = useState(false)

  /**
   * Clear local session state without contacting the server.
   */
  const onSessionClearedRef = useRef(onSessionCleared)
  onSessionClearedRef.current = onSessionCleared

  const clearSession = useCallback(() => {
    setToken('')
    onSessionClearedRef.current()
  }, [])

  /**
   * Restore the session using the refresh-token cookie when present.
   * Distinguishes an auth failure (401/403 from the refresh endpoint) from a
   * network error (fetch itself throws), since only the former should log the user out.
   * @returns {Promise<RefreshResult>} The outcome of the refresh attempt.
   */
  const refreshSession = useCallback(async (): Promise<RefreshResult> => {
    let res: Response
    let data: any

    try {
      ;({ res, data } = await requestJson(`${apiBase}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      }))
    } catch {
      return { status: 'network-error' }
    }

    if (res.status === 401 || res.status === 403) return { status: 'auth-failed' }

    if (res.ok && data?.accessToken) {
      setToken(data.accessToken)
      return { status: 'ok', token: data.accessToken }
    }

    return { status: 'network-error' }
  }, [apiBase])

  /**
   * Perform a fetch with the current access token, transparently refreshing
   * the session and retrying once when the server responds with 401.
   */
  const authedRequest = useCallback((url: string, init: RequestInit = {}) => (
    authorizedRequest(url, init, token, async () => {
      const result = await refreshSession()
      if (result.status === 'ok') return result.token
      if (result.status === 'auth-failed') {
        clearSession()
        setMessage('세션이 만료되었습니다. 다시 로그인해 주세요.')
      }
      return null
    })
  ), [token, refreshSession, clearSession, setMessage])

  /**
   * Authenticate with the admin username and password.
   */
  const loginUser = async () => {
    if (loggingInRef.current) return
    loggingInRef.current = true
    setLoggingIn(true)

    try {
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
    } catch {
      setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      loggingInRef.current = false
      setLoggingIn(false)
    }
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

    clearSession()
    setMessage('로그아웃되었습니다.')
  }

  useEffect(() => {
    refreshSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { login, setLogin, token, refreshSession, authedRequest, loginUser, loggingIn, logoutUser }
}
