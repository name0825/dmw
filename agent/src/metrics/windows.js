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

export const collectWindowsMetrics = async () => {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
    { windowsHide: true },
  )

  // Parse the PowerShell object output:
  //   Cpu : 12
  //   FreeMem : 12345678
  //   TotalMem : 8388608
  //   FreeDisk : 123456789012
  //   TotalDisk : 234567890123
  const pick = (key) => {
    const match = stdout.match(new RegExp(`${key}\\s*:\\s*([0-9]+)`, 'i'))
    return match ? Number(match[1]) : 0
  }

  const cpuUsage = clamp(pick('Cpu'))

  // FreePhysicalMemory / TotalVisibleMemorySize are in KB.
  const freeKb = pick('FreeMem')
  const totalKb = pick('TotalMem')
  const memoryUsage = totalKb > 0 ? clamp(((totalKb - freeKb) / totalKb) * 100) : 0

  const freeBytes = pick('FreeDisk')
  const totalBytes = pick('TotalDisk')
  const diskUsage = totalBytes > 0 ? clamp(((totalBytes - freeBytes) / totalBytes) * 100) : 0

  return {
    cpuUsage: Number(cpuUsage.toFixed(1)),
    memoryUsage: Number(memoryUsage.toFixed(1)),
    diskUsage: Number(diskUsage.toFixed(1)),
  }
}
