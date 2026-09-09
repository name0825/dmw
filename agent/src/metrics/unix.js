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

const getMemoryUsage = () => {
  const total = os.totalmem()
  const free = os.freemem()
  return total > 0 ? clamp(((total - free) / total) * 100) : 0
}

// Parses `df -P /` output. Returns undefined (rather than 0) on failure, so
// the field can be omitted from the heartbeat payload instead of reporting a
// misleading 0% usage.
const getDiskUsage = async () => {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '/'])
    const lines = stdout.trim().split('\n')
    const parts = lines[lines.length - 1].trim().split(/\s+/)
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
  const [cpuUsage, diskUsage] = await Promise.all([getCpuUsage(), getDiskUsage()])
  const memoryUsage = getMemoryUsage()

  const metrics = {
    cpuUsage: Number(cpuUsage.toFixed(1)),
    memoryUsage: Number(memoryUsage.toFixed(1)),
  }
  if (diskUsage !== undefined) {
    metrics.diskUsage = Number(diskUsage.toFixed(1))
  }
  return metrics
}
