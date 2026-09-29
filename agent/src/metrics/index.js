import os from 'node:os'
import { collectWindowsMetrics } from './windows.js'
import { collectUnixMetrics } from './unix.js'

let warnedStubIgnored = false

const useStub = () => {
  if (!process.env.DMW_STUB_METRICS) return false
  if (process.env.NODE_ENV === 'test') return true
  if (!warnedStubIgnored) {
    warnedStubIgnored = true
    console.warn('DMW_STUB_METRICS는 NODE_ENV=test에서만 적용됩니다. 실제 메트릭을 수집합니다.')
  }
  return false
}

export const collectMetrics = () =>
  useStub()
    ? Promise.resolve({ cpuUsage: 0, memoryUsage: 0, diskUsage: 0 })
    : os.platform() === 'win32' ? collectWindowsMetrics() : collectUnixMetrics()
