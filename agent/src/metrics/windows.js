import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const clamp = (value) => Math.max(0, Math.min(100, value))

// Uses PowerShell Get-CimInstance instead of `wmic`, which is removed by
// default on Windows 11 24H2+. A single query returns CPU, memory, and disk.
const PS_SCRIPT = [
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
  '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -First 1',
  '[pscustomobject]@{',
  '  Cpu = [int]$cpu',
  '  FreeMem = [long]$os.FreePhysicalMemory',
  '  TotalMem = [long]$os.TotalVisibleMemorySize',
  '  FreeDisk = [long]$disk.FreeSpace',
  '  TotalDisk = [long]$disk.Size',
  '}',
].join('\n')

const POWERSHELL_TIMEOUT_MS = 8000

export const collectWindowsMetrics = async ({ exec = execFileAsync } = {}) => {
  let stdout
  try {
    ;({ stdout } = await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS },
    ))
  } catch (error) {
    console.warn(`[metrics] PowerShell 메트릭 수집 실패: ${error.message}`)
    return {}
  }

  // Parse the PowerShell object output:
  //   Cpu : 12
  //   FreeMem : 12345678
  //   TotalMem : 8388608
  //   FreeDisk : 123456789012
  //   TotalDisk : 234567890123
  const pick = (key) => {
    const match = stdout.match(new RegExp(`${key}\\s*:\\s*([0-9]+)`, 'i'))
    return match ? Number(match[1]) : undefined
  }

  // Unparseable values stay undefined (omitted from the heartbeat) rather than reporting 0%.
  const usage = (free, total) => (free !== undefined && total > 0 ? clamp(((total - free) / total) * 100) : undefined)

  const cpu = pick('Cpu')
  const cpuUsage = cpu !== undefined ? clamp(cpu) : undefined

  // FreePhysicalMemory / TotalVisibleMemorySize are in KB.
  const memoryUsage = usage(pick('FreeMem'), pick('TotalMem'))
  const diskUsage = usage(pick('FreeDisk'), pick('TotalDisk'))

  const metrics = {}
  if (cpuUsage !== undefined) metrics.cpuUsage = Number(cpuUsage.toFixed(1))
  if (memoryUsage !== undefined) metrics.memoryUsage = Number(memoryUsage.toFixed(1))
  if (diskUsage !== undefined) metrics.diskUsage = Number(diskUsage.toFixed(1))
  return metrics
}
