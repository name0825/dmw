import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

import { buildPsScript, parseWindowsOutput, collectWindowsMetrics } from '../src/metrics/windows.js'
import { parseDfDisks, parseLsblkDisks } from '../src/metrics/unix.js'
import { collectLinuxDisks, collectLinuxSensors, parseSmbiosType17, diskBaseName } from '../src/metrics/linux.js'
import { METRIC_KEYS, normalizeSelect, parseCollectSelection } from '../src/metrics/select.js'
import { collectMetrics } from '../src/metrics/index.js'

const GiB = 1024 ** 3

const WINDOWS_OUTPUT = [
  'Cpu : 20',
  'FreeMem : 250',
  'TotalMem : 1000',
  'CpuClock : 3200',
  'CpuTemp : 54',
  'MemClock : 4800',
  `Disk : C:|${100 * GiB}|${400 * GiB}|41`,
  `Disk : D:|${900 * GiB}|${1000 * GiB}|`,
  '',
].join('\r\n')

test('windows output parses multi-disk lines with temps, clocks and max aggregate', () => {
  assert.deepEqual(parseWindowsOutput(WINDOWS_OUTPUT), {
    cpuUsage: 20,
    memoryUsage: 75,
    cpuClockMhz: 3200,
    cpuTempC: 54,
    memoryClockMhz: 4800,
    diskUsage: 75,
    disks: [{ name: 'C:', usage: 75, tempC: 41 }, { name: 'D:', usage: 10 }],
  })
})

test('windows output omits missing sensors and invalid values', () => {
  const metrics = parseWindowsOutput(['Cpu : 5', 'CpuTemp : 0', 'CpuClock : 0', 'Disk : C:|10|0|99', 'Disk : E:|10|100|300'].join('\n'))
  assert.deepEqual(metrics, { cpuUsage: 5, disks: [{ name: 'E:', usage: 90 }] , diskUsage: 90 })
  assert.equal('cpuTempC' in metrics, false)
  assert.equal('cpuClockMhz' in metrics, false)
  assert.equal('memoryClockMhz' in metrics, false)
})

test('windows cpu clock uses the effective-frequency counter with a CurrentClockSpeed fallback', () => {
  const script = buildPsScript(['cpu_clock'])
  assert.ok(script.includes("Win32_PerfFormattedData_Counters_ProcessorInformation -Filter \"Name='_Total'\""))
  assert.ok(script.includes('$p.ProcessorFrequency * $p.PercentProcessorPerformance / 100'))
  assert.ok(script.includes('CurrentClockSpeed'))
  assert.ok(script.includes('"CpuClock : $c"'))
})

test('windows output falls back to legacy FreeDisk/TotalDisk without Disk lines', () => {
  const metrics = parseWindowsOutput('FreeDisk : 400\nTotalDisk : 1000\n')
  assert.deepEqual(metrics, { diskUsage: 60 })
})

test('windows selection drops unselected fields and script sections', () => {
  const select = ['cpu_usage', 'disk_usage']
  const metrics = parseWindowsOutput(WINDOWS_OUTPUT, select)
  assert.deepEqual(metrics, { cpuUsage: 20, diskUsage: 75, disks: [{ name: 'C:', usage: 75 }, { name: 'D:', usage: 10 }] })

  const script = buildPsScript(select)
  assert.ok(script.includes('Cpu :') && script.includes('Disk :'))
  assert.equal(script.includes('FreeMem'), false)
  assert.equal(script.includes('CpuTemp'), false)
  assert.equal(script.includes('Get-PhysicalDisk'), false)
  assert.ok(buildPsScript(METRIC_KEYS).includes('Get-PhysicalDisk'))
  assert.equal(buildPsScript(['disk_temp']).includes('Get-PhysicalDisk'), true)
})

test('windows with no selectable metric skips PowerShell', async () => {
  let called = false
  const exec = async () => { called = true; return { stdout: '' } }
  assert.deepEqual(await collectWindowsMetrics({ exec, select: [] }), {})
  assert.deepEqual(await collectWindowsMetrics({ exec, select: ['memory_temp', 'bogus'] }), {})
  assert.equal(called, false)
})

test('windows collect passes the selection-specific script to PowerShell', async () => {
  let script
  const metrics = await collectWindowsMetrics({
    exec: async (_cmd, args) => { script = args[3]; return { stdout: WINDOWS_OUTPUT } },
    select: ['cpu_temp'],
  })
  assert.deepEqual(metrics, { cpuTempC: 54 })
  assert.ok(script.includes('MSAcpi_ThermalZoneTemperature'))
  assert.equal(script.includes('Win32_OperatingSystem'), false)
})

const DF_OUTPUT = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  'tmpfs               800000       100    799900       1% /run',
  'overlay           10000000   5000000   5000000      50% /',
  '/dev/sda2         10000000   2500000   7500000      25% /',
  '/dev/sda2         10000000   2500000   7500000      25% /mnt/bind',
  '/dev/loop3            1000      1000         0     100% /snap/core/1',
  '/dev/sdb1         20000000  15000000   5000000      75% /mnt/my data',
  '/dev/sdc1                0         0         0        - /mnt/empty',
  '/dev/fuse           131072        16    131056       1% /etc/pve',
].join('\n')

test('df parsing on Linux keeps only the root filesystem', () => {
  assert.deepEqual(parseDfDisks(DF_OUTPUT, 'linux'), [
    { name: '/', source: '/dev/sda2', usage: 25 },
  ])
  assert.deepEqual(parseDfDisks('Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 1 1 0 100% /run', 'linux'), [])
})

test('df parsing on macOS skips system snapshot volumes except Data', () => {
  const stdout = [
    'Filesystem   1024-blocks      Used Available Capacity Mounted on',
    '/dev/disk3s1s1  500000000  10000000 200000000     5% /',
    '/dev/disk3s6    500000000   2000000 200000000     1% /System/Volumes/VM',
    '/dev/disk3s5    500000000 300000000 200000000    60% /System/Volumes/Data',
    '/dev/disk5s1      1000000    500000    500000    50% /Volumes/External',
    '/dev/disk3s3    500000000 300000000 200000000    60% /Volumes/Recovery',
  ].join('\n')
  assert.deepEqual(parseDfDisks(stdout, 'darwin').map((d) => [d.name, d.usage]), [
    ['/System/Volumes/Data', 60],
    ['/Volumes/External', 50],
  ])
})

test('df parsing on macOS keeps the Data volume even when Recovery is listed first', () => {
  const stdout = [
    'Filesystem   1024-blocks      Used Available Capacity Mounted on',
    '/dev/disk3s3    500000000 300000000 200000000    60% /Volumes/Recovery',
    '/dev/disk5s1      1000000    500000    500000    50% /Volumes/External',
    '/dev/disk3s5    500000000 300000000 200000000    60% /System/Volumes/Data',
  ].join('\n')
  assert.deepEqual(parseDfDisks(stdout, 'darwin').map((d) => d.name), ['/System/Volumes/Data', '/Volumes/External'])
})

const withTmp = (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-sys-'))
  try { return fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('Linux physical inventory includes unmounted HDDs without inventing usage', () => {
  assert.deepEqual(parseLsblkDisks(JSON.stringify({ blockdevices: [
    { name: 'nvme0n1', type: 'disk', size: 256060514304 },
    { name: 'sda', type: 'disk', size: '2000398934016' },
    { name: 'sdb', type: 'disk', size: 8001563222016 },
    { name: 'loop0', type: 'loop', size: 1000 },
    { name: 'dm-0', type: 'lvm', size: 1000 },
    { name: '../bad', type: 'disk', size: 1000 },
  ] })), [
    { name: 'nvme0n1', source: '/dev/nvme0n1', kind: 'physical', sizeBytes: 256060514304 },
    { name: 'sda', source: '/dev/sda', kind: 'physical', sizeBytes: 2000398934016 },
    { name: 'sdb', source: '/dev/sdb', kind: 'physical', sizeBytes: 8001563222016 },
  ])
  assert.equal(parseLsblkDisks(JSON.stringify({ blockdevices: Array.from({ length: 40 }, (_, i) => ({ name: `sd${i}`, type: 'disk', size: 1000 })) })).length, 32)
  assert.deepEqual(parseLsblkDisks('{}'), [])
  assert.throws(() => parseLsblkDisks('invalid JSON'))
})

test('Linux collector retains physical disks and reports only root filesystem usage', async (t) => {
  const devices = Array.from({ length: 32 }, (_, i) => ({ name: `sd${i}`, type: 'disk', size: 1000000 }))
  const exec = () => { throw new Error('unexpected callback invocation') }
  exec[promisify.custom] = async (command, args) => {
    if (command === 'lsblk') return { stdout: JSON.stringify({ blockdevices: devices }) }
    assert.equal(command, 'df')
    assert.deepEqual(args, ['-P', '-k', '/'])
    return { stdout: ['Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/sd0 100 25 75 25% /', '/dev/sd1 100 90 10 90% /boot/efi', '/dev/sd2 100 95 5 95% /mnt/data'].join('\n') }
  }
  const originalExecFile = childProcess.execFile
  childProcess.execFile = exec
  t.mock.method(os, 'platform', () => 'linux')
  t.mock.method(fs, 'statSync', () => ({ isBlockDevice: () => true }))
  syncBuiltinESMExports()
  try {
    const { collectUnixMetrics } = await import('../src/metrics/unix.js?disk-limits')
    const metrics = await collectUnixMetrics({ select: ['disk_usage'] })
    assert.equal(metrics.disks.length, 33)
    assert.equal(metrics.disks.filter((disk) => disk.kind === 'physical').length, 32)
    assert.deepEqual(metrics.disks.filter((disk) => disk.kind === 'filesystem'), [{ name: '/', kind: 'filesystem', usage: 25 }])
    assert.equal(metrics.diskUsage, 25)
    assert.ok(metrics.disks.filter((disk) => disk.kind === 'physical').every((disk) => disk.usage === undefined))
  } finally {
    childProcess.execFile = originalExecFile
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

for (const [label, line, statSync] of [
  ['/dev/root without a device node', '/dev/root 100 40 60 40% /', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }],
  ['a ZFS dataset', 'rpool/ROOT/ubuntu 100 40 60 40% /', () => ({ isBlockDevice: () => false })],
]) {
  test(`Linux collector falls back to root usage when the root source is ${label}`, async (t) => {
    const exec = () => { throw new Error('unexpected callback invocation') }
    exec[promisify.custom] = async (command) => {
      if (command === 'lsblk') return { stdout: JSON.stringify({ blockdevices: [] }) }
      assert.equal(command, 'df')
      return { stdout: ['Filesystem 1024-blocks Used Available Capacity Mounted on', line].join('\n') }
    }
    const originalExecFile = childProcess.execFile
    childProcess.execFile = exec
    t.mock.method(os, 'platform', () => 'linux')
    t.mock.method(fs, 'statSync', statSync)
    syncBuiltinESMExports()
    try {
      const { collectUnixMetrics } = await import(`../src/metrics/unix.js?root-fallback-${encodeURIComponent(label)}`)
      const metrics = await collectUnixMetrics({ select: ['disk_usage'] })
      assert.deepEqual(metrics.disks.filter((disk) => disk.kind === 'filesystem'), [{ name: '/', kind: 'filesystem', usage: 40 }])
      assert.equal(metrics.diskUsage, 40)
    } finally {
      childProcess.execFile = originalExecFile
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}

test('sysfs inventory fallback excludes partitions and virtual devices and retains temperatures', () => withTmp((root) => {
  const disk = path.join(root, 'devices/pci/nvme0n1')
  const virtual = path.join(root, 'devices/virtual/block/dm-0')
  fs.mkdirSync(path.join(disk, 'nvme0n1p2'), { recursive: true })
  fs.mkdirSync(virtual, { recursive: true })
  fs.mkdirSync(path.join(root, 'class/block'), { recursive: true })
  fs.writeFileSync(path.join(disk, 'size'), '500000000')
  fs.writeFileSync(path.join(disk, 'nvme0n1p2/partition'), '2')
  fs.symlinkSync(disk, path.join(root, 'class/block/nvme0n1'), 'junction')
  fs.symlinkSync(path.join(disk, 'nvme0n1p2'), path.join(root, 'class/block/nvme0n1p2'), 'junction')
  fs.symlinkSync(virtual, path.join(root, 'class/block/dm-0'), 'junction')
  const hwmon = path.join(root, 'class/hwmon/hwmon0')
  fs.mkdirSync(path.join(hwmon, 'device/nvme0n1'), { recursive: true })
  fs.writeFileSync(path.join(hwmon, 'name'), 'nvme')
  fs.writeFileSync(path.join(hwmon, 'temp1_input'), '48000')
  const disks = collectLinuxDisks(root)
  assert.deepEqual(disks, [{ name: 'nvme0n1', source: '/dev/nvme0n1', kind: 'physical', sizeBytes: 256000000000 }])
  assert.deepEqual(collectLinuxSensors({ sysRoot: root, select: ['disk_temp'], disks }), { diskTemps: [48] })
}))
const write = (root, rel, content) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('linux hwmon tree yields cpu, memory and nvme temps and cpufreq clock', () => withTmp((root) => {
  write(root, 'class/hwmon/hwmon0/name', 'coretemp\n')
  write(root, 'class/hwmon/hwmon0/temp1_label', 'Package id 0\n')
  write(root, 'class/hwmon/hwmon0/temp1_input', '61000\n')
  write(root, 'class/hwmon/hwmon0/temp2_label', 'Core 0\n')
  write(root, 'class/hwmon/hwmon0/temp2_input', '70000\n')
  write(root, 'class/hwmon/hwmon1/name', 'spd5118\n')
  write(root, 'class/hwmon/hwmon1/temp1_input', '38500\n')
  write(root, 'class/hwmon/hwmon2/name', 'nvme\n')
  write(root, 'class/hwmon/hwmon2/temp1_input', '47000\n')
  fs.mkdirSync(path.join(root, 'class/hwmon/hwmon2/device/nvme0n1'), { recursive: true })
  write(root, 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '2400000\n')
  write(root, 'devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', '3600000\n')

  const result = collectLinuxSensors({ sysRoot: root, procRoot: path.join(root, 'proc'), disks: [] })
  assert.equal(result.cpuTempC, 61)
  assert.equal(result.memoryTempC, 38.5)
  assert.equal(result.cpuClockMhz, 3600)
  assert.equal(result.memoryClockMhz, undefined)
  assert.deepEqual(result.diskTemps, [])
}))

test('linux cpu temp falls back to max input and then thermal zones', () => withTmp((root) => {
  write(root, 'class/hwmon/hwmon0/name', 'k10temp\n')
  write(root, 'class/hwmon/hwmon0/temp1_input', '40000\n')
  write(root, 'class/hwmon/hwmon0/temp2_input', '52000\n')
  assert.equal(collectLinuxSensors({ sysRoot: root, select: ['cpu_temp'] }).cpuTempC, 52)

  withTmp((other) => {
    write(other, 'class/thermal/thermal_zone0/type', 'battery\n')
    write(other, 'class/thermal/thermal_zone0/temp', '99000\n')
    write(other, 'class/thermal/thermal_zone1/type', 'x86_pkg_temp\n')
    write(other, 'class/thermal/thermal_zone1/temp', '45000\n')
    assert.equal(collectLinuxSensors({ sysRoot: other, select: ['cpu_temp'] }).cpuTempC, 45)
  })
}))

test('linux cpu clock falls back to /proc/cpuinfo', () => withTmp((root) => {
  write(root, 'proc/cpuinfo', 'processor : 0\ncpu MHz\t\t: 1800.250\nprocessor : 1\ncpu MHz\t\t: 2999.9\n')
  const result = collectLinuxSensors({ sysRoot: path.join(root, 'sys'), procRoot: path.join(root, 'proc'), select: ['cpu_clock'] })
  assert.deepEqual(result, { cpuClockMhz: 3000 })
}))

test('linux sensors return {} for a missing sysfs and honor selection', () => withTmp((root) => {
  const missing = path.join(root, 'nope')
  assert.deepEqual(collectLinuxSensors({ sysRoot: missing, procRoot: missing }), { diskTemps: [] })
  assert.deepEqual(collectLinuxSensors({ sysRoot: missing, procRoot: missing, select: ['cpu_temp', 'memory_clock'] }), {})
  write(root, 'class/hwmon/hwmon0/name', 'coretemp\n')
  write(root, 'class/hwmon/hwmon0/temp1_input', '50000\n')
  assert.deepEqual(collectLinuxSensors({ sysRoot: root, select: ['cpu_usage', 'disk_usage'] }), {})
}))

test('linux maps volumes to disk temps through partition and device-mapper links', () => withTmp((root) => {
  const disk = path.join(root, 'devices/pci/nvme0n1')
  fs.mkdirSync(path.join(disk, 'nvme0n1p3'), { recursive: true })
  write(root, 'devices/pci/nvme0n1/nvme0n1p3/partition', '3\n')
  fs.mkdirSync(path.join(root, 'class/block'), { recursive: true })
  fs.symlinkSync(disk, path.join(root, 'class/block/nvme0n1'), 'junction')
  fs.symlinkSync(path.join(disk, 'nvme0n1p3'), path.join(root, 'class/block/nvme0n1p3'), 'junction')
  fs.mkdirSync(path.join(root, 'class/block/dm-0/slaves/nvme0n1p3'), { recursive: true })
  write(root, 'class/hwmon/hwmon0/name', 'nvme\n')
  write(root, 'class/hwmon/hwmon0/temp1_input', '47000\n')
  fs.mkdirSync(path.join(root, 'class/hwmon/hwmon0/device/nvme0n1'), { recursive: true })

  assert.equal(diskBaseName('/dev/nvme0n1p3', root), 'nvme0n1')
  assert.equal(diskBaseName('/dev/nvme0n1', root), 'nvme0n1')
  assert.equal(diskBaseName('/dev/dm-0', root), 'nvme0n1')
  assert.equal(diskBaseName('/dev/missing9', root), undefined)

  const disks = [{ source: '/dev/nvme0n1p3' }, { source: '/dev/dm-0' }, { source: '/dev/sdz1' }]
  assert.deepEqual(collectLinuxSensors({ sysRoot: root, select: ['disk_temp'], disks }), { diskTemps: [47, 47, undefined] })
}))

test('smbios type 17 parsing prefers configured speed and ignores empty values', () => {
  const entry = (length, size, rated, configured) => {
    const buf = Buffer.alloc(length)
    buf[0] = 17
    buf[1] = length
    buf.writeUInt16LE(size, 12)
    buf.writeUInt16LE(rated, 0x15)
    if (length >= 0x22) buf.writeUInt16LE(configured, 0x20)
    return buf
  }
  assert.equal(parseSmbiosType17(entry(0x28, 8192, 5600, 4800)), 4800)
  assert.equal(parseSmbiosType17(entry(0x1b, 8192, 2666, 0)), 2666)
  assert.equal(parseSmbiosType17(entry(0x28, 0, 0, 0)), undefined)
  assert.equal(parseSmbiosType17(entry(0x28, 8192, 5600, 0xffff)), undefined)
  assert.equal(parseSmbiosType17(Buffer.alloc(4)), undefined)
  assert.equal(parseSmbiosType17(undefined), undefined)
})

test('selection defaults to all 8 keys and ignores unknown keys', () => {
  assert.equal(METRIC_KEYS.length, 8)
  assert.deepEqual([...normalizeSelect(undefined)], METRIC_KEYS)
  assert.deepEqual([...normalizeSelect(['cpu_temp', 'bogus', 'disk_usage'])], ['cpu_temp', 'disk_usage'])
  assert.deepEqual([...normalizeSelect([])], [])
})

test('heartbeat response collect list is applied; old server responses keep collecting all', () => {
  assert.deepEqual(parseCollectSelection({ status: 'ok', collect: ['cpu_usage', 'nope', 'cpu_temp'] }), ['cpu_usage', 'cpu_temp'])
  assert.deepEqual(parseCollectSelection({ status: 'ok', collect: [] }), [])
  assert.equal(parseCollectSelection({ status: 'ok' }), undefined)
  assert.equal(parseCollectSelection({ status: 'ok', collect: 'cpu_usage' }), undefined)
  assert.equal(parseCollectSelection(undefined), undefined)
  assert.equal(parseCollectSelection(null), undefined)

  let collect
  collect = parseCollectSelection({ status: 'ok' }) ?? collect
  assert.equal(collect, undefined)
  assert.deepEqual([...normalizeSelect(collect)], METRIC_KEYS)
})

test('collectMetrics with an empty selection collects nothing and ignores unknown keys', async () => {
  assert.deepEqual(await collectMetrics([]), {})
  assert.deepEqual(await collectMetrics(['bogus']), {})
})
