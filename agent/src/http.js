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
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })

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
