export const METRIC_KEYS = [
  'cpu_usage',
  'memory_usage',
  'disk_usage',
  'cpu_temp',
  'memory_temp',
  'disk_temp',
  'cpu_clock',
  'memory_clock',
]

export const normalizeSelect = (select) =>
  new Set(select === undefined ? METRIC_KEYS : [...select].filter((key) => METRIC_KEYS.includes(key)))

export const parseCollectSelection = (response) =>
  Array.isArray(response?.collect) ? response.collect.filter((key) => METRIC_KEYS.includes(key)) : undefined
