import { useEffect, useRef, useState } from 'react'

import type { AgentRelease } from '../types'

export const useAgentRelease = (
  apiBase: string,
  token: string,
  authedRequest: (url: string, init?: RequestInit) => Promise<{ res: Response; data: any }>,
  setMessage: (message: string) => void,
) => {
  const [release, setRelease] = useState<AgentRelease | null>(null)
  const [checking, setChecking] = useState(false)
  const requestRef = useRef(0)

  /**
   * Fetch the latest agent release known to the server.
   * @param {boolean} refresh - Ask the server to bypass its cache.
   */
  const checkRelease = async (refresh = false) => {
    if (!token) return
    const request = requestRef.current + 1
    requestRef.current = request
    setChecking(true)

    try {
      const { res, data } = await authedRequest(`${apiBase}/agent-release/latest${refresh ? '?refresh=1' : ''}`)
      if (request !== requestRef.current) return

      if (!res.ok || !data) {
        setMessage('최신 에이전트 버전을 확인하지 못했습니다.')
        return
      }

      setRelease(data)
      if (refresh) {
        setMessage(data.version ? `최신 에이전트 버전: v${data.version}` : '최신 에이전트 버전을 확인하지 못했습니다.')
      }
    } catch {
      if (request === requestRef.current) setMessage('네트워크 오류로 요청에 실패했습니다.')
    } finally {
      if (request === requestRef.current) setChecking(false)
    }
  }

  useEffect(() => {
    if (!token) {
      requestRef.current += 1
      setRelease(null)
      setChecking(false)
      return
    }
    void checkRelease()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return { release, checking, checkRelease }
}
