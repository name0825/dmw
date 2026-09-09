import os from 'node:os'
import { collectWindowsMetrics } from './windows.js'
import { collectUnixMetrics } from './unix.js'

export const collectMetrics = () =>
  os.platform() === 'win32' ? collectWindowsMetrics() : collectUnixMetrics()
