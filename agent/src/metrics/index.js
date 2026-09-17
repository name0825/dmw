import os from 'node:os'
import { collectWindowsMetrics } from './windows.js'
import { collectUnixMetrics } from './unix.js'

export const collectMetrics = () =>
  process.env.DMW_STUB_METRICS
    ? Promise.resolve({ cpuUsage: 0, memoryUsage: 0, diskUsage: 0 })
    : os.platform() === 'win32' ? collectWindowsMetrics() : collectUnixMetrics()
