import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeSelect } from './select.js'

const execFileAsync = promisify(execFile)

const clamp = (value) => Math.max(0, Math.min(100, value))

const MAX_DISKS = 32
const MAX_TEMP_C = 125

// Uses PowerShell Get-CimInstance instead of `wmic`, which is removed by
// default on Windows 11 24H2+. Each sensor is its own try/catch so a failing
// sensor only drops its own field.
export const buildPsScript = (select) => {
  const sel = normalizeSelect(select)
  const lines = []
  if (sel.has('cpu_usage')) {
    lines.push('try { "Cpu : $([int](Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average)" } catch {}')
  }
  if (sel.has('memory_usage')) {
    lines.push('try { $o = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; "FreeMem : $([long]$o.FreePhysicalMemory)"; "TotalMem : $([long]$o.TotalVisibleMemorySize)" } catch {}')
  }
  if (sel.has('cpu_clock')) {
    lines.push('try { "CpuClock : $([int](Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property CurrentClockSpeed -Maximum).Maximum)" } catch {}')
  }
  if (sel.has('cpu_temp')) {
    lines.push('try { $m = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object { $_.CurrentTemperature / 10 - 273.15 } | Measure-Object -Maximum; if ($m.Count -gt 0) { "CpuTemp : $([int][math]::Round($m.Maximum))" } } catch {}')
  }
  if (sel.has('memory_clock')) {
    lines.push('try { $m = Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | Measure-Object -Property ConfiguredClockSpeed -Maximum; if ($m.Maximum -gt 0) { "MemClock : $([int]$m.Maximum)" } } catch {}')
  }
  if (sel.has('disk_usage') || sel.has('disk_temp')) {
    lines.push('$temps = @{}')
    if (sel.has('disk_temp')) {
      lines.push('try { foreach ($p in Get-PhysicalDisk -ErrorAction Stop) { try { $c = $p | Get-StorageReliabilityCounter -ErrorAction Stop; if ($c.Temperature -gt 0) { $temps[[string]$p.DeviceId] = [int]$c.Temperature } } catch {} } } catch {}')
    }
    lines.push('try { foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop) { if ($d.Size -gt 0) { $t = \'\'; try { $n = [string](Get-Partition -DriveLetter $d.DeviceID.Substring(0,1) -ErrorAction Stop).DiskNumber; if ($temps.ContainsKey($n)) { $t = $temps[$n] } } catch {}; "Disk : $($d.DeviceID)|$([long]$d.FreeSpace)|$([long]$d.Size)|$t" } } } catch {}')
  }
  return lines.join('\n')
}

const POWERSHELL_TIMEOUT_MS = 8000

// Parses the `Key : value` lines produced by buildPsScript:
//   Cpu : 12
//   FreeMem : 12345678
//   TotalMem : 8388608
//   Disk : C:|123456789012|234567890123|41
// The legacy FreeDisk/TotalDisk pair is still accepted when there are no `Disk :` lines.
export const parseWindowsOutput = (stdout, select) => {
  const sel = normalizeSelect(select)
  const pick = (key) => {
    const match = stdout.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9]+)`, 'im'))
    return match ? Number(match[1]) : undefined
  }

  // Unparseable values stay undefined (omitted from the heartbeat) rather than reporting 0%.
  const usage = (free, total) => (free !== undefined && total > 0 ? clamp(((total - free) / total) * 100) : undefined)

  const metrics = {}

  const cpu = pick('Cpu')
  if (sel.has('cpu_usage') && cpu !== undefined) metrics.cpuUsage = Number(clamp(cpu).toFixed(1))

  // FreePhysicalMemory / TotalVisibleMemorySize are in KB.
  const memoryUsage = usage(pick('FreeMem'), pick('TotalMem'))
  if (sel.has('memory_usage') && memoryUsage !== undefined) metrics.memoryUsage = Number(memoryUsage.toFixed(1))

  const cpuTemp = pick('CpuTemp')
  if (sel.has('cpu_temp') && cpuTemp > 0 && cpuTemp <= MAX_TEMP_C) metrics.cpuTempC = cpuTemp
  const cpuClock = pick('CpuClock')
  if (sel.has('cpu_clock') && cpuClock > 0) metrics.cpuClockMhz = cpuClock
  const memoryClock = pick('MemClock')
  if (sel.has('memory_clock') && memoryClock > 0) metrics.memoryClockMhz = memoryClock

  const disks = []
  for (const match of stdout.matchAll(/^\s*Disk\s*:\s*(.+?)\s*$/gim)) {
    const [rawName, free, total, temp] = match[1].split('|')
    const name = rawName.trim()
    const size = Number(total)
    if (!name || !Number.isFinite(Number(free)) || !(size > 0)) continue
    const disk = { name }
    if (sel.has('disk_usage')) disk.usage = Number(clamp(((size - Number(free)) / size) * 100).toFixed(1))
    const tempC = Number(temp)
    if (sel.has('disk_temp') && tempC > 0 && tempC <= MAX_TEMP_C) disk.tempC = Math.round(tempC)
    if (disk.usage !== undefined || disk.tempC !== undefined) disks.push(disk)
  }
  if (disks.length > 0) {
    metrics.disks = disks.slice(0, MAX_DISKS)
    if (sel.has('disk_usage')) metrics.diskUsage = Math.max(...metrics.disks.map((disk) => disk.usage))
  } else if (sel.has('disk_usage')) {
    const diskUsage = usage(pick('FreeDisk'), pick('TotalDisk'))
    if (diskUsage !== undefined) metrics.diskUsage = Number(diskUsage.toFixed(1))
  }
  return metrics
}

export const collectWindowsMetrics = async ({ exec = execFileAsync, select } = {}) => {
  const script = buildPsScript(select)
  if (!script) return {}
  let stdout
  try {
    ;({ stdout } = await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS },
    ))
  } catch (error) {
    console.warn(`[metrics] PowerShell 메트릭 수집 실패: ${error.message}`)
    return {}
  }
  return parseWindowsOutput(stdout, select)
}
