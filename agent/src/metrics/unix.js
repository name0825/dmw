import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

export const collectUnixMetrics = async () => {
  const [cpuUsage, diskUsage, memoryUsage] = await Promise.all([getCpuUsage(), getDiskUsage(), getMemoryUsage()])

  const metrics = {
    cpuUsage: Number(cpuUsage.toFixed(1)),
    memoryUsage: Number(memoryUsage.toFixed(1)),
  }
  if (diskUsage !== undefined) {
    metrics.diskUsage = Number(diskUsage.toFixed(1))
  }
  return metrics
}
