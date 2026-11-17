import { normalizeUsage } from './utils/validation.js'

export const METRIC_KEYS = [
  'cpu_usage',
  'memory_usage',
  'disk_usage',
  'cpu_temp',
  'memory_temp',
  'disk_temp',
  'cpu_clock',
  'memory_clock',
] as const

export type MetricKey = (typeof METRIC_KEYS)[number]

export type DiskMetric = { name: string; usage?: number; tempC?: number }

export type ExtraMetrics = {
  cpuTemp?: number
  memoryTemp?: number
  cpuClock?: number
  memoryClock?: number
  disks?: DiskMetric[]
}

export type HeartbeatMetrics = ExtraMetrics & {
  cpuUsage?: number
  memoryUsage?: number
  diskUsage?: number
}

const MAX_DISKS = 32
const MAX_DISK_NAME_LENGTH = 64

const isMetricKey = (value: unknown): value is MetricKey =>
  typeof value === 'string' && (METRIC_KEYS as readonly string[]).includes(value)

export const parseMetricSelection = (raw: string | null | undefined): MetricKey[] => {
  if (raw === null || raw === undefined) return [...METRIC_KEYS]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...METRIC_KEYS]
    return METRIC_KEYS.filter((key) => parsed.includes(key))
  } catch {
    return [...METRIC_KEYS]
  }
}

export const validateMetricSelection = (input: unknown): MetricKey[] | null => {
  if (!Array.isArray(input)) return null
  if (!input.every(isMetricKey)) return null
  return METRIC_KEYS.filter((key) => input.includes(key))
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const sanitizeTemp = (value: unknown): number | undefined => {
  const n = finiteNumber(value)
  return n !== undefined && n >= -50 && n <= 150 ? n : undefined
}

const sanitizeClock = (value: unknown): number | undefined => {
  const n = finiteNumber(value)
  return n !== undefined && n > 0 && n <= 20000 ? n : undefined
}

const sanitizeDisks = (value: unknown): DiskMetric[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const disks: DiskMetric[] = []
  for (const item of value.slice(0, MAX_DISKS)) {
    if (!item || typeof item !== 'object') continue
    const { name: rawName, usage: rawUsage, tempC: rawTemp } = item as Record<string, unknown>
    if (typeof rawName !== 'string') continue
    const name = rawName.trim()
    if (name.length < 1 || name.length > MAX_DISK_NAME_LENGTH) continue
    const disk: DiskMetric = { name }
    const usage = normalizeUsage(rawUsage)
    if (usage !== null) disk.usage = usage
    const tempC = sanitizeTemp(rawTemp)
    if (tempC !== undefined) disk.tempC = tempC
    if (disk.usage === undefined && disk.tempC === undefined) continue
    disks.push(disk)
  }
  return disks
}

export const sanitizeExtraMetrics = (body: any): ExtraMetrics => {
  const source = (body || {}) as Record<string, unknown>
  const result: ExtraMetrics = {}
  const cpuTemp = sanitizeTemp(source.cpuTempC)
  if (cpuTemp !== undefined) result.cpuTemp = cpuTemp
  const memoryTemp = sanitizeTemp(source.memoryTempC)
  if (memoryTemp !== undefined) result.memoryTemp = memoryTemp
  const cpuClock = sanitizeClock(source.cpuClockMhz)
  if (cpuClock !== undefined) result.cpuClock = cpuClock
  const memoryClock = sanitizeClock(source.memoryClockMhz)
  if (memoryClock !== undefined) result.memoryClock = memoryClock
  const disks = sanitizeDisks(source.disks)
  if (disks && disks.length > 0) result.disks = disks
  return result
}

export const applySelection = <T extends HeartbeatMetrics>(metrics: T, selection: MetricKey[]): T => {
  const selected = new Set<MetricKey>(selection)
  const result: HeartbeatMetrics = { ...metrics }
  if (!selected.has('cpu_usage')) delete result.cpuUsage
  if (!selected.has('memory_usage')) delete result.memoryUsage
  if (!selected.has('disk_usage')) delete result.diskUsage
  if (!selected.has('cpu_temp')) delete result.cpuTemp
  if (!selected.has('memory_temp')) delete result.memoryTemp
  if (!selected.has('cpu_clock')) delete result.cpuClock
  if (!selected.has('memory_clock')) delete result.memoryClock
  if (result.disks) {
    const keepUsage = selected.has('disk_usage')
    const keepTemp = selected.has('disk_temp')
    const disks = result.disks
      .map((disk) => {
        const next: DiskMetric = { name: disk.name }
        if (keepUsage && disk.usage !== undefined) next.usage = disk.usage
        if (keepTemp && disk.tempC !== undefined) next.tempC = disk.tempC
        return next
      })
      .filter((disk) => disk.usage !== undefined || disk.tempC !== undefined)
    if (disks.length > 0) result.disks = disks
    else delete result.disks
  }
  return result as T
}

export const serializeDeviceRow = <T extends Record<string, any>>(row: T) => {
  const { disks_json: disksJson, metric_selection: selectionRaw, ...rest } = row
  let disks: DiskMetric[] | null = null
  if (typeof disksJson === 'string') {
    try {
      const parsed: unknown = JSON.parse(disksJson)
      if (Array.isArray(parsed)) disks = parsed as DiskMetric[]
    } catch {
      disks = null
    }
  }
  return {
    ...rest,
    metric_selection: parseMetricSelection(selectionRaw),
    disks,
  }
}
