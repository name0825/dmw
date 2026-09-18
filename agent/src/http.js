// Minimal JSON fetch wrapper shared by pairing and heartbeat requests.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const requestJson = async (url, options = {}) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    ...options,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })

  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(res.status, '서버가 리다이렉트를 반환했습니다. https:// 주소를 사용하세요.')
  }

  const text = await res.text()
  const parseFailed = Symbol('parseFailed')
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = parseFailed
  }

  if (!res.ok) {
    const message = (data !== parseFailed && data?.message) || 'Request failed'
    throw new HttpError(res.status, `${res.status}: ${message}`)
  }

  if (data === parseFailed) throw new Error(`Invalid JSON response (${res.status})`)

  return data
}
