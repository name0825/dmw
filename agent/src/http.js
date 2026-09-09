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
  const data = text ? JSON.parse(text) : {}

  if (!res.ok) {
    const message = data.message || 'Request failed'
    throw new HttpError(res.status, `${res.status}: ${message}`)
  }

  return data
}
