import fs from 'node:fs'
import path from 'node:path'
import { normalizeSelect } from './select.js'

const MAX_TEMP_C = 125

const safe = (fn) => {
  try { return fn() } catch { return undefined }
}

const readText = (file) => safe(() => fs.readFileSync(file, 'utf8').trim())
const readMilli = (file) => {
  const value = Number(readText(file))
  const celsius = value / 1000
  return Number.isFinite(value) && celsius > 0 && celsius <= MAX_TEMP_C ? celsius : undefined
}
const listDir = (dir) => safe(() => fs.readdirSync(dir)) ?? []
const maxOf = (values) => {
  const valid = values.filter((value) => value !== undefined)
  return valid.length > 0 ? Math.max(...valid) : undefined
}

const hwmons = (sysRoot) => {
  const base = path.join(sysRoot, 'class/hwmon')
  return listDir(base)
    .filter((entry) => entry.startsWith('hwmon'))
    .map((entry) => ({ dir: path.join(base, entry), name: readText(path.join(base, entry, 'name')) }))
}

const tempInputs = (dir) => listDir(dir).filter((file) => /^temp\d+_input$/.test(file))

const hwmonMaxTemp = (dir) => maxOf(tempInputs(dir).map((file) => readMilli(path.join(dir, file))))

const CPU_HWMON = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal']
const CPU_THERMAL_ZONE = ['x86_pkg_temp', 'cpu-thermal', 'cpu_thermal', 'soc-thermal', 'acpitz']
const MEMORY_HWMON = ['jc42', 'spd5118']

const cpuTemp = (sysRoot) => {
  for (const { dir, name } of hwmons(sysRoot)) {
    if (!CPU_HWMON.includes(name)) continue
    const labeled = listDir(dir)
      .filter((file) => /^temp\d+_label$/.test(file) && /Package|Tctl|Tdie/.test(readText(path.join(dir, file)) ?? ''))
      .map((file) => readMilli(path.join(dir, file.replace('_label', '_input'))))
    const value = maxOf(labeled) ?? hwmonMaxTemp(dir)
    if (value !== undefined) return value
  }
  const zones = path.join(sysRoot, 'class/thermal')
  for (const zone of listDir(zones).filter((entry) => entry.startsWith('thermal_zone'))) {
    if (!CPU_THERMAL_ZONE.includes(readText(path.join(zones, zone, 'type')))) continue
    const value = readMilli(path.join(zones, zone, 'temp'))
    if (value !== undefined) return value
  }
  return undefined
}

const memoryTemp = (sysRoot) =>
  maxOf(hwmons(sysRoot).filter(({ name }) => MEMORY_HWMON.includes(name)).map(({ dir }) => hwmonMaxTemp(dir)))

const diskTempsByName = (sysRoot) => {
  const temps = new Map()
  for (const { dir, name } of hwmons(sysRoot)) {
    let disks = []
    if (name === 'nvme') disks = listDir(path.join(dir, 'device')).filter((entry) => /^nvme\d+n\d+$/.test(entry))
    else if (name === 'drivetemp') disks = listDir(path.join(dir, 'device/block'))
    const value = readMilli(path.join(dir, 'temp1_input'))
    if (value === undefined) continue
    for (const disk of disks) temps.set(disk, value)
  }
  return temps
}

export const diskBaseName = (source, sysRoot = '/sys', depth = 0) =>
  safe(() => {
    let dev = path.basename(source)
    if (depth === 0) dev = safe(() => path.basename(fs.realpathSync(source))) ?? dev
    const real = fs.realpathSync(path.join(sysRoot, 'class/block', dev))
    if (fs.existsSync(path.join(real, 'partition'))) return path.basename(path.dirname(real))
    if (/^(dm-|md)/.test(dev) && depth < 3) {
      const [slave] = fs.readdirSync(path.join(real, 'slaves'))
      return slave ? diskBaseName(slave, sysRoot, depth + 1) : undefined
    }
    return dev
  })

const cpuClock = (sysRoot, procRoot) => {
  const cpuDir = path.join(sysRoot, 'devices/system/cpu')
  const freqs = listDir(cpuDir)
    .filter((entry) => /^cpu\d+$/.test(entry))
    .map((entry) => Number(readText(path.join(cpuDir, entry, 'cpufreq/scaling_cur_freq'))) / 1000)
    .filter((mhz) => Number.isFinite(mhz) && mhz > 0)
  if (freqs.length > 0) return Math.round(Math.max(...freqs))
  const cpuinfo = readText(path.join(procRoot, 'cpuinfo')) ?? ''
  const speeds = [...cpuinfo.matchAll(/^cpu MHz\s*:\s*([0-9.]+)/gim)].map((match) => Number(match[1])).filter((mhz) => mhz > 0)
  return speeds.length > 0 ? Math.round(Math.max(...speeds)) : undefined
}

// SMBIOS type 17 (Memory Device): configured speed at 0x20 (SMBIOS 2.7+),
// otherwise the rated speed at 0x15. Size word at offset 12 is 0 for empty slots.
export const parseSmbiosType17 = (buf) => {
  if (!buf || buf.length < 0x17 || buf[0] !== 17) return undefined
  const hasConfigured = buf[1] >= 0x22 && buf.length >= 0x22 && buf.readUInt16LE(12) !== 0
  const speed = hasConfigured ? buf.readUInt16LE(0x20) : buf.readUInt16LE(0x15)
  return speed > 0 && speed !== 0xffff ? speed : undefined
}

const memoryClock = (sysRoot) => {
  const entries = path.join(sysRoot, 'firmware/dmi/entries')
  return maxOf(
    listDir(entries)
      .filter((entry) => entry.startsWith('17-'))
      .map((entry) => parseSmbiosType17(safe(() => fs.readFileSync(path.join(entries, entry, 'raw'))))),
  )
}

export const collectLinuxSensors = ({ sysRoot = '/sys', procRoot = '/proc', select, disks = [] } = {}) => {
  const sel = normalizeSelect(select)
  const result = {}
  const set = (key, value) => { if (value !== undefined) result[key] = value }
  if (sel.has('cpu_temp')) set('cpuTempC', safe(() => cpuTemp(sysRoot)))
  if (sel.has('memory_temp')) set('memoryTempC', safe(() => memoryTemp(sysRoot)))
  if (sel.has('cpu_clock')) set('cpuClockMhz', safe(() => cpuClock(sysRoot, procRoot)))
  if (sel.has('memory_clock')) set('memoryClockMhz', safe(() => memoryClock(sysRoot)))
  if (sel.has('disk_temp')) {
    const temps = safe(() => diskTempsByName(sysRoot)) ?? new Map()
    result.diskTemps = disks.map((disk) => {
      const base = temps.size > 0 ? diskBaseName(disk.source, sysRoot) : undefined
      const value = base === undefined ? undefined : temps.get(base)
      return value === undefined ? undefined : Math.round(value)
    })
  }
  return result
}
