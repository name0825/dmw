import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { collectLinuxSensors } from './linux.js'
import { normalizeSelect } from './select.js'

const execFileAsync = promisify(execFile)

const clamp = (value) => Math.max(0, Math.min(100, value))

const readCpuTimes = () => {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const key of Object.keys(cpu.times)) {
      total += cpu.times[key]
    }
    idle += cpu.times.idle
  }
  return { idle, total }
}

// os.loadavg() is not a usage percentage, so CPU usage is derived from the
// idle/total tick delta between two samples instead.
let lastSnapshot = null

const getCpuUsage = async () => {
  const start = lastSnapshot || readCpuTimes()
  if (!lastSnapshot) {
    // No baseline yet: take a short sample so the first heartbeat has a real value.
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const end = readCpuTimes()
  lastSnapshot = end

  const idleDelta = end.idle - start.idle
  const totalDelta = end.total - start.total
  return totalDelta > 0 ? clamp(100 - (idleDelta / totalDelta) * 100) : 0
}

const getFreeMemoryUsage = () => {
  const total = os.totalmem()
  const free = os.freemem()
  return total > 0 ? clamp(((total - free) / total) * 100) : 0
}

// os.freemem() on macOS counts only truly free pages, so reclaimable cache
// (inactive/speculative) shows as used. Mirror Activity Monitor's "Memory Used"
// instead: app memory (anonymous - purgeable) + wired + compressed pages from
// `vm_stat`. "Pages active" is not used because it includes file-backed cache.
export const parseVmStat = (stdout, total) => {
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1])
  const pages = (label) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1])
  const appMemory = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'))
  const used = appMemory + pages('Pages wired down') + pages('Pages occupied by compressor')
  if (!Number.isFinite(pageSize) || !Number.isFinite(used) || total <= 0) return undefined
  return clamp(((used * pageSize) / total) * 100)
}

const getMemoryUsage = async () => {
  if (os.platform() !== 'darwin') return getFreeMemoryUsage()
  try {
    const { stdout } = await execFileAsync('vm_stat')
    return parseVmStat(stdout, os.totalmem()) ?? getFreeMemoryUsage()
  } catch {
    return getFreeMemoryUsage()
  }
}

// On macOS (APFS) `/` is the sealed read-only system snapshot, so its usage is
// tiny; user data lives on the Data volume, which shares the container's free
// space. Usage is computed as (size - available) / size to match Finder.
const DISK_PATH = os.platform() === 'darwin' ? '/System/Volumes/Data' : '/'

// Parses `df -P` output. Returns undefined (rather than 0) on failure, so
// the field can be omitted from the heartbeat payload instead of reporting a
// misleading 0% usage.
const getDiskUsage = async () => {
  try {
    const { stdout } = await execFileAsync('df', ['-P', DISK_PATH])
    const lines = stdout.trim().split('\n')
    const parts = lines[lines.length - 1].trim().split(/\s+/)
    const size = Number(parts[1])
    const available = Number(parts[3])
    if (Number.isFinite(size) && Number.isFinite(available) && size > 0) {
      return clamp(((size - available) / size) * 100)
    }
    const capacity = parts[4]
    if (capacity && capacity.endsWith('%')) {
      return clamp(Number(capacity.slice(0, -1)))
    }
    return undefined
  } catch {
    return undefined
  }
}

const MAX_DISKS = 32

// Parses `df -P -k` output into one entry per real block-device volume.
export const parseDfDisks = (stdout, platform = os.platform()) => {
  const disks = []
  const seen = new Set()
  for (const line of stdout.trim().split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    const source = cols[0]
    const mount = cols.slice(5).join(' ')
    if (!source?.startsWith('/dev/') || source.startsWith('/dev/loop') || !mount || seen.has(source)) continue
    if (platform === 'darwin' && (mount === '/' || (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data'))) continue
    const size = Number(cols[1])
    const available = Number(cols[3])
    if (!(size > 0) || !Number.isFinite(available)) continue
    seen.add(source)
    disks.push({ name: mount, source, usage: Number(clamp(((size - available) / size) * 100).toFixed(1)) })
  }
  return disks.slice(0, MAX_DISKS)
}

const getDisks = async () => {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '-k'], { timeout: 10000 })
    const disks = parseDfDisks(stdout)
    if (disks.length > 0) return disks
  } catch {
    // fall through to the single-path fallback
  }
  const usage = await getDiskUsage()
  return usage === undefined ? [] : [{ name: DISK_PATH, usage: Number(usage.toFixed(1)) }]
}

export const collectUnixMetrics = async ({ select } = {}) => {
  const sel = normalizeSelect(select)
  const wantDisks = sel.has('disk_usage') || sel.has('disk_temp')
  const [cpuUsage, memoryUsage, volumes] = await Promise.all([
    sel.has('cpu_usage') ? getCpuUsage() : undefined,
    sel.has('memory_usage') ? getMemoryUsage() : undefined,
    wantDisks ? getDisks() : [],
  ])

  const metrics = {}
  if (cpuUsage !== undefined) metrics.cpuUsage = Number(cpuUsage.toFixed(1))
  if (memoryUsage !== undefined) metrics.memoryUsage = Number(memoryUsage.toFixed(1))

  let sensors = {}
  if (os.platform() === 'linux') {
    try { sensors = collectLinuxSensors({ select: sel, disks: volumes }) } catch { sensors = {} }
  }
  for (const key of ['cpuTempC', 'memoryTempC', 'cpuClockMhz', 'memoryClockMhz']) {
    if (sensors[key] !== undefined) metrics[key] = sensors[key]
  }
  if (metrics.cpuClockMhz === undefined && sel.has('cpu_clock')) {
    const speed = os.cpus()[0]?.speed
    if (speed > 0) metrics.cpuClockMhz = speed
  }

  const disks = volumes
    .map((volume, index) => {
      const disk = { name: volume.name }
      if (sel.has('disk_usage')) disk.usage = volume.usage
      if (sensors.diskTemps?.[index] !== undefined) disk.tempC = sensors.diskTemps[index]
      return disk
    })
    .filter((disk) => disk.usage !== undefined || disk.tempC !== undefined)
  if (disks.length > 0) metrics.disks = disks
  if (sel.has('disk_usage') && disks.length > 0) metrics.diskUsage = Math.max(...disks.map((disk) => disk.usage))
  return metrics
}
