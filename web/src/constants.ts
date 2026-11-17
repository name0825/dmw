import type { MetricKey } from './types'

export const METRIC_OPTIONS: { key: MetricKey; label: string }[] = [
  { key: 'cpu_usage', label: 'CPU 사용량' },
  { key: 'memory_usage', label: '메모리 사용량' },
  { key: 'disk_usage', label: '디스크 사용량' },
  { key: 'cpu_temp', label: 'CPU 온도' },
  { key: 'memory_temp', label: '메모리 온도' },
  { key: 'disk_temp', label: '디스크 온도' },
  { key: 'cpu_clock', label: 'CPU 클럭' },
  { key: 'memory_clock', label: '메모리 클럭' },
]

export const MAC_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
