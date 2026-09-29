const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 연속 실패 횟수에 따라 heartbeat 재시도 간격을 지수적으로 늘린다.
// baseMs에서 시작해 두 배씩 증가하며 capMs를 넘지 않고, 지터를 더해 동시 재시도가 몰리는 것을 막는다.
const computeBackoffDelay = (baseMs, failureCount, { capMs = 5 * 60 * 1000, jitterRatio = 0.1, random = Math.random } = {}) => {
  if (!Number.isFinite(failureCount) || failureCount <= 0) return baseMs
  const raw = baseMs * (2 ** (failureCount - 1))
  const capped = Math.min(capMs, raw)
  return Math.round(capped + capped * jitterRatio * random())
}

export { sleep, computeBackoffDelay }
