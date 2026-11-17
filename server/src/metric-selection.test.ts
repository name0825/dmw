import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

import {
  METRIC_KEYS,
  applySelection,
  parseMetricSelection,
  sanitizeExtraMetrics,
  serializeDeviceRow,
  validateMetricSelection,
} from './metricSelection.js'
import { initDb } from './database/schema.js'

test('parseMetricSelection defaults to all keys for null or invalid input', () => {
  assert.deepEqual(parseMetricSelection(null), [...METRIC_KEYS])
  assert.deepEqual(parseMetricSelection('not json'), [...METRIC_KEYS])
  assert.deepEqual(parseMetricSelection('{"a":1}'), [...METRIC_KEYS])
  assert.deepEqual(parseMetricSelection('[]'), [])
  assert.deepEqual(parseMetricSelection('["cpu_temp","nope","cpu_usage"]'), ['cpu_usage', 'cpu_temp'])
})

test('validateMetricSelection rejects non-arrays and unknown keys and dedupes', () => {
  assert.equal(validateMetricSelection('cpu_usage'), null)
  assert.equal(validateMetricSelection(['cpu_usage', 'x']), null)
  assert.deepEqual(validateMetricSelection([]), [])
  assert.deepEqual(validateMetricSelection(['disk_temp', 'disk_temp', 'cpu_usage']), ['cpu_usage', 'disk_temp'])
})

test('sanitizeExtraMetrics keeps valid values and drops invalid ones', () => {
  const result = sanitizeExtraMetrics({
    cpuTempC: 60,
    memoryTempC: 'x',
    cpuClockMhz: 0,
    memoryClockMhz: 4800,
    disks: [{ name: ' C: ', usage: 50, tempC: 200 }, { name: 'x'.repeat(65) }, null, { usage: 1 }],
  })
  assert.deepEqual(result, { cpuTemp: 60, memoryClock: 4800, disks: [{ name: 'C:', usage: 50 }] })
  assert.deepEqual(sanitizeExtraMetrics(undefined), {})
  assert.equal(sanitizeExtraMetrics({ disks: Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, usage: 1 })) }).disks?.length, 32)
})

test('applySelection drops unselected metrics and per-disk fields', () => {
  const metrics = { cpuUsage: 1, diskUsage: 2, cpuTemp: 3, disks: [{ name: 'C:', usage: 2, tempC: 30 }] }
  assert.deepEqual(applySelection(metrics, ['disk_temp']), { disks: [{ name: 'C:', tempC: 30 }] })
  assert.deepEqual(applySelection(metrics, ['cpu_usage', 'disk_usage']), { cpuUsage: 1, diskUsage: 2, disks: [{ name: 'C:', usage: 2 }] })
  assert.deepEqual(applySelection(metrics, []), {})
})

test('physical disk inventory survives sanitization and selection without fabricated usage', () => {
  const metrics = sanitizeExtraMetrics({ disks: [
    { name: 'sda', kind: 'physical', sizeBytes: 2000398934016, usage: 90 },
    { name: 'nvme0n1', kind: 'physical', sizeBytes: 256060514304, tempC: 48 },
    { name: '/', kind: 'filesystem', usage: 27.5 },
    { name: 'invalid', kind: 'other' },
  ] })
  assert.deepEqual(metrics.disks, [
    { name: 'sda', kind: 'physical', sizeBytes: 2000398934016 },
    { name: 'nvme0n1', kind: 'physical', sizeBytes: 256060514304, tempC: 48 },
    { name: '/', kind: 'filesystem', usage: 27.5 },
  ])
  assert.deepEqual(applySelection(metrics, ['disk_usage']).disks, [
    { name: 'sda', kind: 'physical', sizeBytes: 2000398934016 },
    { name: 'nvme0n1', kind: 'physical', sizeBytes: 256060514304 },
    { name: '/', kind: 'filesystem', usage: 27.5 },
  ])
  assert.deepEqual(applySelection(metrics, ['disk_temp']).disks, metrics.disks?.slice(0, 2))
  assert.deepEqual(applySelection(metrics, []), {})
  assert.deepEqual(sanitizeExtraMetrics({ disks: [{ name: 'sda', kind: 'physical', sizeBytes: Infinity }] }).disks, [{ name: 'sda', kind: 'physical' }])
})

test('disk limits independently allow 32 physical devices and 32 volumes without expanding legacy limits', () => {
  const physical = Array.from({ length: 32 }, (_, i) => ({ name: `sd${i}`, kind: 'physical' }))
  const volumes = Array.from({ length: 32 }, (_, i) => ({ name: `/mnt/sd${i}`, kind: 'filesystem', usage: i + 1 }))
  assert.deepEqual(sanitizeExtraMetrics({ disks: [...physical, ...volumes] }).disks, [...physical, ...volumes])
  assert.deepEqual(sanitizeExtraMetrics({ disks: [...volumes, ...physical] }).disks, [...volumes, ...physical])
  assert.equal(sanitizeExtraMetrics({ disks: [...physical, ...physical] }).disks?.length, 32)
  assert.equal(sanitizeExtraMetrics({ disks: [...volumes, ...volumes] }).disks?.length, 32)
  assert.equal(sanitizeExtraMetrics({ disks: Array.from({ length: 64 }, (_, i) => ({ name: `d${i}`, usage: 1 })) }).disks?.length, 32)
})

test('serializeDeviceRow hides disks_json and exposes parsed disks and selection', () => {
  const row = serializeDeviceRow({ id: 1, disks_json: '[{"name":"C:","usage":5}]', metric_selection: '["cpu_usage"]' })
  assert.deepEqual(row, { id: 1, metric_selection: ['cpu_usage'], disks: [{ name: 'C:', usage: 5 }] })
  assert.deepEqual(serializeDeviceRow({ id: 2, disks_json: null, metric_selection: null }).disks, null)
})

test('initDb adds the metric columns to an old-shape database and is idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-metric-migration-test-'))
  const db = (await sqlite.open({ filename: path.join(directory, 'old.db'), driver: sqlite3.Database })) as any
  try {
    await db.exec(`
      CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mac_address TEXT NOT NULL, ip_address TEXT NOT NULL, agent_key_hint TEXT, status TEXT NOT NULL DEFAULT 'NOT_PAIRED', created_at TEXT, updated_at TEXT);
      CREATE TABLE device_metrics_latest (device_id INTEGER PRIMARY KEY, cpu_usage REAL, memory_usage REAL, disk_usage REAL, updated_at TEXT);
      CREATE TABLE device_metrics_history (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, timestamp TEXT NOT NULL, cpu_usage REAL, memory_usage REAL, disk_usage REAL);
    `)
    await initDb(db)
    await initDb(db)

    const names = async (table: string) => (await db.all(`PRAGMA table_info(${table})`)).map((column: any) => column.name)
    assert.ok((await names('devices')).includes('metric_selection'))
    for (const table of ['device_metrics_latest', 'device_metrics_history']) {
      const columns = await names(table)
      for (const column of ['cpu_temp', 'memory_temp', 'cpu_clock', 'memory_clock', 'disks_json']) {
        assert.ok(columns.includes(column), `${table}.${column} should exist`)
      }
    }
  } finally {
    await db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
