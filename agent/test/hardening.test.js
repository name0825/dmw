import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectWindowsMetrics } from '../src/metrics/windows.js'
import { ensureStateDir } from '../src/credentials.js'

const quiet = async (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (message) => warnings.push(message)
  try { return [await fn(), warnings] } finally { console.warn = original }
}

test('windows metrics pass a timeout to PowerShell', async () => {
  let options
  const stdout = 'Cpu : 10\nFreeMem : 250\nTotalMem : 1000\nFreeDisk : 400\nTotalDisk : 1000\n'
  const metrics = await collectWindowsMetrics({ exec: async (_cmd, _args, opts) => { options = opts; return { stdout } } })
  assert.ok(options.timeout > 0 && options.timeout < 20000)
  assert.deepEqual(metrics, { cpuUsage: 10, memoryUsage: 75, diskUsage: 60 })
})

test('windows metrics return undefined fields when PowerShell times out', async () => {
  const [metrics, warnings] = await quiet(() => collectWindowsMetrics({
    exec: async () => { throw Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM' }) },
  }))
  assert.equal(metrics.cpuUsage, undefined)
  assert.equal(metrics.memoryUsage, undefined)
  assert.equal(metrics.diskUsage, undefined)
  assert.equal(warnings.length, 1)
})

test('windows metrics return undefined (not 0) for unparseable fields', async () => {
  const metrics = await collectWindowsMetrics({ exec: async () => ({ stdout: 'Cpu : 5\ngarbage\n' }) })
  assert.equal(metrics.cpuUsage, 5)
  assert.equal(metrics.memoryUsage, undefined)
  assert.equal(metrics.diskUsage, undefined)
  assert.equal('memoryUsage' in metrics, false)
})

test('state dir is created with 0700 and existing dirs are chmodded on non-Windows', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-dir-'))
  try {
    const fresh = path.join(root, 'fresh')
    ensureStateDir(fresh)
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700)
    const existing = path.join(root, 'existing')
    fs.mkdirSync(existing, { mode: 0o755 })
    fs.chmodSync(existing, 0o755)
    ensureStateDir(existing)
    assert.equal(fs.statSync(existing).mode & 0o777, 0o700)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('windows state dir ACL is restricted once, at creation, via icacls args array', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-acl-'))
  const previous = { user: process.env.USERNAME, domain: process.env.USERDOMAIN }
  process.env.USERNAME = 'tester'
  delete process.env.USERDOMAIN
  try {
    const calls = []
    const run = (...args) => { calls.push(args) }
    const dir = path.join(root, 'state')
    ensureStateDir(dir, { platform: 'win32', run })
    ensureStateDir(dir, { platform: 'win32', run })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'icacls')
    assert.ok(Array.isArray(calls[0][1]))
    assert.equal(calls[0][1][0], dir)
    assert.ok(calls[0][1].some((arg) => arg.startsWith('tester:')))
    assert.ok(calls[0][1].some((arg) => arg.startsWith('*S-1-5-18:')))
    assert.ok(calls[0][1].some((arg) => arg.startsWith('*S-1-5-32-544:')))
  } finally {
    if (previous.user === undefined) delete process.env.USERNAME; else process.env.USERNAME = previous.user
    if (previous.domain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = previous.domain
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('windows ACL is applied to an existing dir without marker, and retried after failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-aclmarker-'))
  const previous = { user: process.env.USERNAME, domain: process.env.USERDOMAIN }
  process.env.USERNAME = 'tester'
  delete process.env.USERDOMAIN
  const warn = console.warn
  try {
    const dir = path.join(root, 'state')
    fs.mkdirSync(dir)
    let calls = 0
    console.warn = () => {}
    ensureStateDir(dir, { platform: 'win32', run: () => { calls++; throw new Error('boom') } })
    console.warn = warn
    ensureStateDir(dir, { platform: 'win32', run: () => { calls++ } })
    ensureStateDir(dir, { platform: 'win32', run: () => { calls++ } })
    assert.equal(calls, 2)
    assert.ok(fs.existsSync(path.join(dir, '.acl-v1')))
  } finally {
    console.warn = warn
    if (previous.user === undefined) delete process.env.USERNAME; else process.env.USERNAME = previous.user
    if (previous.domain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = previous.domain
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('windows ACL failure only warns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-aclfail-'))
  const savedUser = process.env.USERNAME
  process.env.USERNAME ??= 'dmw-test'
  try {
    const [, warnings] = await quiet(() => ensureStateDir(path.join(root, 'state'), {
      platform: 'win32',
      run: () => { throw new Error('icacls boom') },
    }))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /icacls boom/)
  } finally {
    if (savedUser === undefined) delete process.env.USERNAME
    fs.rmSync(root, { recursive: true, force: true })
  }
})
