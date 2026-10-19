import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { autostartEntry, installLauncher } from '../src/autostart.js'
import { parseArgs } from '../src/config.js'
import { checkForUpdate, confirmActiveVersion, isNewerVersion, validateBundle } from '../src/update.js'
import { acquireLock } from '../src/credentials.js'
import { HttpError, requestJson } from '../src/http.js'
import { computeBackoffDelay } from '../src/retry.js'

const agentEntry = fileURLToPath(new URL('../src/index.js', import.meta.url))

const withStateDir = async (fn) => {
  const previous = process.env.DMW_STATE_DIR
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-agent-test-'))
  process.env.DMW_STATE_DIR = directory
  try {
    return await fn(directory)
  } finally {
    if (previous === undefined) delete process.env.DMW_STATE_DIR
    else process.env.DMW_STATE_DIR = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body: (async function* () { yield Buffer.isBuffer(body) ? body : Buffer.from(body) })(),
})

test('--interval rejects values outside the 1000-20000ms range and accepts the bounds', () => {
  assert.throws(() => parseArgs(['--interval', '999']), /1000 이상 20000 이하/)
  assert.throws(() => parseArgs(['--interval', '20001']), /1000 이상 20000 이하/)
  assert.equal(parseArgs(['--interval', '1000']).interval, '1000')
  assert.equal(parseArgs(['--interval', '20000']).interval, '20000')
})

test('computeBackoffDelay doubles from the base interval, caps at 5 minutes, and resets when failureCount is 0', () => {
  const noJitter = { random: () => 0 }
  assert.equal(computeBackoffDelay(10000, 0, noJitter), 10000)
  assert.equal(computeBackoffDelay(10000, 1, noJitter), 10000)
  assert.equal(computeBackoffDelay(10000, 2, noJitter), 20000)
  assert.equal(computeBackoffDelay(10000, 3, noJitter), 40000)
  assert.equal(computeBackoffDelay(10000, 20, noJitter), 5 * 60 * 1000)

  const maxJitter = { random: () => 1 }
  const withJitter = computeBackoffDelay(10000, 2, maxJitter)
  assert.ok(withJitter > 20000 && withJitter <= 22000)
})

test('CLI options expose unpairing, autostart, update, and background controls', () => {
  const parsed = parseArgs(['--unpair', '--enable-autostart', '--no-update', '--background'])
  assert.equal(parsed.unpair, true)
  assert.equal(parsed.enableAutostart, true)
  assert.equal(parsed.noUpdate, true)
  assert.equal(parsed.background, true)

  const alternate = parseArgs(['--disable-autostart', '--update'])
  assert.equal(alternate.disableAutostart, true)
  assert.equal(alternate.update, true)
})

test('autostart entries target only the generated launcher for each supported platform', () => {
  const windows = autostartEntry({ platform: 'win32', appData: 'C:/Users/test/AppData/Roaming', node: 'C:/Program Files/node.exe', launcher: 'C:/agent/launcher.cjs' })
  assert.match(windows.file, /Startup[\\/]DMW Agent\.vbs$/)
  const windowsText = windows.content.subarray(2).toString('utf16le')
  assert.match(windowsText, /node\.exe/)
  assert.match(windowsText, /launcher\.cjs/)

  const mac = autostartEntry({ platform: 'darwin', home: '/Users/test', node: '/usr/local/bin/node', launcher: '/state/launcher.cjs' })
  assert.match(mac.file, /Users[\\/]test[\\/]Library[\\/]LaunchAgents[\\/]io\.dmw\.agent\.plist$/)
  assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(mac.content, /<string>\/state\/launcher\.cjs<\/string>/)

  const linux = autostartEntry({ platform: 'linux', home: '/home/test', node: '/usr/bin/node', launcher: '/state/launcher.cjs' })
  assert.match(linux.file, /home[\\/]test[\\/]\.config[\\/]autostart[\\/]dmw-agent\.desktop$/)
  assert.match(linux.content, /^\[Desktop Entry\]/)
  assert.match(linux.content, /Exec="\/usr\/bin\/node" "\/state\/launcher\.cjs"/)
})

test('windows .vbs is UTF-16LE with BOM and keeps non-ASCII launcher paths intact', () => {
  const { content } = autostartEntry({ platform: 'win32', appData: 'C:/Users/test/AppData/Roaming', node: 'C:/Program Files/node.exe', launcher: 'C:/사용자/에이전트/launcher.cjs' })
  assert.deepEqual([...content.subarray(0, 2)], [0xff, 0xfe])
  assert.match(content.subarray(2).toString('utf16le'), /C:\/사용자\/에이전트\/launcher\.cjs/)
})

const currentBoot = () => Math.round(Date.now() / 1000 - os.uptime())

test('acquireLock reclaims empty-old, dead-pid, and pre-reboot locks but respects live ones', async () => {
  await withStateDir(async (state) => {
    const lock = path.join(state, 'probe.lock')

    fs.writeFileSync(lock, '')
    const past = new Date(Date.now() - 120000)
    fs.utimesSync(lock, past, past)
    const release = acquireLock('probe')
    assert.equal(typeof release, 'function')
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid)
    release()

    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => dead.once('exit', resolve))
    fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid, boot: currentBoot() }))
    const afterDead = acquireLock('probe')
    assert.equal(typeof afterDead, 'function')
    afterDead()

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, boot: currentBoot() - 100000 }))
    assert.equal(acquireLock('probe'), null)
    fs.utimesSync(lock, past, past)
    const afterReboot = acquireLock('probe')
    assert.equal(typeof afterReboot, 'function')
    afterReboot()

    fs.writeFileSync(lock, String(process.pid))
    assert.equal(acquireLock('probe'), null)

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, boot: currentBoot() }))
    assert.equal(acquireLock('probe'), null)

    fs.writeFileSync(lock, '')
    assert.equal(acquireLock('probe'), null)
  })
})

test('installLauncher run from a versions/ dir keeps the existing launcher bundled fallback when bundled.json is missing', async () => {
  await withStateDir(async (state) => {
    const bundledEntry = path.join(state, 'bundled-root', 'index.js')
    fs.mkdirSync(path.dirname(bundledEntry), { recursive: true })
    fs.writeFileSync(bundledEntry, '')
    fs.writeFileSync(path.join(state, 'launcher.cjs'), `const fallback = ${JSON.stringify(bundledEntry)};\n`)
    const versionRoot = path.join(state, 'versions', '9.9.9')
    fs.mkdirSync(path.join(versionRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(versionRoot, 'package.json'), '{"type":"module"}')
    for (const name of ['autostart.js', 'credentials.js']) fs.copyFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), path.join(versionRoot, 'src', name))
    const copied = await import(pathToFileURL(path.join(versionRoot, 'src', 'autostart.js')).href)
    copied.installLauncher()
    assert.ok(fs.readFileSync(path.join(state, 'launcher.cjs'), 'utf8').includes(`const fallback = ${JSON.stringify(bundledEntry)};`))
    assert.equal(fs.existsSync(path.join(state, 'bundled.json')), false)
  })
})

const runLauncher =(state) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [installLauncher()], { env: { ...process.env, DMW_STATE_DIR: state, DMW_RESTART_DELAY_MS: '10' }, stdio: 'ignore' })
  child.once('error', reject)
  child.once('exit', (code) => resolve(code))
})
const writeVersion = (state, version, source) => {
  const dir = path.join(state, 'versions', version, 'src')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), source)
}

test('launcher rolls back a pending version that keeps crashing and blocks it from reinstalling', async () => {
  await withStateDir(async (state) => {
    writeVersion(state, '1.1.0', 'process.exit(1)')
    writeVersion(state, '1.0.0', "const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.env.DMW_STATE_DIR, 'rollback-marker'), 'ok'); process.exit(0)")
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.1.0', pending: true, previous: '1.0.0' }))
    assert.equal(await runLauncher(state), 0)
    assert.equal(fs.readFileSync(path.join(state, 'rollback-marker'), 'utf8'), 'ok')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.0.0' })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'rollback.json'), 'utf8')), { version: '1.1.0' })

    const fetchImpl = async () => response(JSON.stringify({ tag_name: 'v1.1.0', assets: [] }))
    assert.equal(await checkForUpdate({ fetchImpl, version: '1.0.0' }), false)
  })
})

test('launcher restarts a non-pending version that crashes until it exits cleanly', async () => {
  await withStateDir(async (state) => {
    writeVersion(state, '1.0.0', "const fs = require('node:fs'); const path = require('node:path'); const file = path.join(process.env.DMW_STATE_DIR, 'runs'); fs.appendFileSync(file, 'x'); process.exit(fs.readFileSync(file, 'utf8').length >= 2 ? 0 : 1)")
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    assert.equal(await runLauncher(state), 0)
    assert.equal(fs.readFileSync(path.join(state, 'runs'), 'utf8'), 'xx')
    assert.equal(fs.existsSync(path.join(state, 'rollback.json')), false)
  })
})

test('confirmActiveVersion clears pending only for the matching version', async () => {
  await withStateDir(async (state) => {
    const file = path.join(state, 'active.json')
    fs.writeFileSync(file, JSON.stringify({ version: '1.1.0', pending: true, previous: '1.0.0' }))
    assert.equal(confirmActiveVersion('1.0.0'), false)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pending, true)
    assert.equal(confirmActiveVersion('1.1.0'), true)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pending, undefined)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.1.0')
  })
})

test('checkForUpdate skips a version recorded in rollback.json', async () => {
  await withStateDir(async (state) => {
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    fs.writeFileSync(path.join(state, 'rollback.json'), JSON.stringify({ version: '1.1.0' }))
    const fetchImpl = async () => response(JSON.stringify({ tag_name: 'v1.1.0', assets: [] }))
    assert.equal(await checkForUpdate({ fetchImpl, version: '1.0.0' }), false)
    assert.equal(fs.existsSync(path.join(state, 'versions')), false)
  })
})

test('launcher restarts once when an active version requests update handoff', async () => {
  await withStateDir(async (state) => {
    const first = path.join(state, 'versions', '1.0.0', 'src')
    const second = path.join(state, 'versions', '1.1.0', 'src')
    fs.mkdirSync(first, { recursive: true })
    fs.mkdirSync(second, { recursive: true })
    fs.writeFileSync(path.join(first, 'index.js'), "const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.env.DMW_STATE_DIR, 'active.json'), JSON.stringify({ version: '1.1.0' })); process.exit(75)")
    fs.writeFileSync(path.join(second, 'index.js'), "const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.env.DMW_STATE_DIR, 'handoff-marker'), 'started'); process.exit(0)")
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const launcher = installLauncher()
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [launcher], { env: { ...process.env, DMW_STATE_DIR: state }, stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (code) => resolve(code))
    })
    assert.equal(result, 0)
    assert.equal(fs.readFileSync(path.join(state, 'handoff-marker'), 'utf8'), 'started')
  })
})

test('version comparison accepts only newer semantic versions', () => {
  assert.equal(isNewerVersion('1.2.4', '1.2.3'), true)
  assert.equal(isNewerVersion('1.3.0', '1.2.99'), true)
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false)
  assert.equal(isNewerVersion('1.2.2', '1.2.3'), false)
  assert.equal(isNewerVersion('v1.2.4', '1.2.3'), false)
})

test('bundle validation rejects checksum mismatch and traversal paths', () => {
  const valid = Buffer.from(JSON.stringify({ version: '1.2.3', files: { 'package.json': JSON.stringify({ version: '1.2.3', type: 'module' }), 'src/index.js': 'export {}' } }))
  const checksum = createHash('sha256').update(valid).digest('hex')
  assert.equal(validateBundle(valid, `${checksum}  dmw-agent-1.2.3.json`, '1.2.3').version, '1.2.3')
  assert.throws(() => validateBundle(valid, '0'.repeat(64), '1.2.3'), /SHA256/)

  const traversal = Buffer.from(JSON.stringify({ version: '1.2.3', files: { 'package.json': JSON.stringify({ version: '1.2.3', type: 'module' }), 'src/index.js': 'export {}', '../owned.js': 'bad' } }))
  const traversalChecksum = createHash('sha256').update(traversal).digest('hex')
  assert.throws(() => validateBundle(traversal, traversalChecksum, '1.2.3'), /허용되지 않은 업데이트 경로/)
})

test('failed update preserves the active version and installs no partial release', async () => {
  await withStateDir(async (state) => {
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files: { 'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }), 'src/index.js': 'export {}' } }))
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.json')) return response(bundle)
      return response('0'.repeat(64))
    }

    await assert.rejects(checkForUpdate({ fetchImpl, version: '1.0.0' }), /SHA256/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.0.0' })
    assert.equal(fs.existsSync(path.join(state, 'versions', '1.1.0')), false)
  })
})

test('a release failing its start check leaves no staging directory behind', async () => {
  await withStateDir(async (state) => {
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files: { 'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }), 'src/index.js': 'process.exit(3)' } }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.sha256')) return response(checksum)
      return response(bundle)
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(checkForUpdate({ fetchImpl, version: '1.0.0' }), /시작 검증 실패/)
    }

    const versions = path.join(state, 'versions')
    assert.deepEqual(fs.existsSync(versions) ? fs.readdirSync(versions) : [], [])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.0.0' })
  })
})

test('verified newer release becomes active only after its entry point starts', async () => {
  await withStateDir(async (state) => {
    const files = {
      'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }),
      'src/index.js': 'if (process.argv.includes("--help")) process.exit(0); process.exit(1)',
    }
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.json')) return response(bundle)
      return response(`${checksum}  dmw-agent-1.1.0.json\n`)
    }

    assert.equal(await checkForUpdate({ fetchImpl, version: '1.0.0' }), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0', pending: true })
    assert.equal(fs.readFileSync(path.join(state, 'versions', '1.1.0', 'src', 'index.js'), 'utf8'), files['src/index.js'])
  })
})

test('validated existing release is recovered as active without overwriting it', async () => {
  await withStateDir(async (state) => {
    const files = {
      'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }),
      'src/index.js': 'if (process.argv.includes("--help")) process.exit(0); process.exit(1)',
    }
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const destination = path.join(state, 'versions', '1.1.0')
    fs.mkdirSync(path.join(destination, 'src'), { recursive: true })
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(destination, name), content)
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.json')) return response(bundle)
      return response(checksum)
    }

    assert.equal(await checkForUpdate({ fetchImpl, version: '1.0.0' }), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0', pending: true, previous: '1.0.0' })
    assert.equal(fs.readFileSync(path.join(destination, 'src', 'index.js'), 'utf8'), files['src/index.js'])
  })
})

test('a stale versions/<next> directory with mismatched contents is replaced and the update succeeds', async () => {
  await withStateDir(async (state) => {
    const files = {
      'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }),
      'src/index.js': 'if (process.argv.includes("--help")) process.exit(0); process.exit(1)',
    }
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const destination = path.join(state, 'versions', '1.1.0')
    fs.mkdirSync(path.join(destination, 'src'), { recursive: true })
    fs.writeFileSync(path.join(destination, 'package.json'), files['package.json'])
    fs.writeFileSync(path.join(destination, 'src', 'index.js'), 'process.exit(1)')
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.json')) return response(bundle)
      return response(checksum)
    }

    assert.equal(await checkForUpdate({ fetchImpl, version: '1.0.0' }), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0', pending: true, previous: '1.0.0' })
    assert.equal(fs.readFileSync(path.join(destination, 'src', 'index.js'), 'utf8'), files['src/index.js'])
  })
})

test('a versions/<next> directory that becomes the active version mid-update is not deleted', async () => {
  await withStateDir(async (state) => {
    const files = {
      'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }),
      'src/index.js': 'process.exit(0)',
    }
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const destination = path.join(state, 'versions', '1.1.0')
    fs.mkdirSync(path.join(destination, 'src'), { recursive: true })
    fs.writeFileSync(path.join(destination, 'package.json'), files['package.json'])
    fs.writeFileSync(path.join(destination, 'src', 'index.js'), 'corrupted')
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.sha256')) {
        // 다운로드가 끝나기 전에 다른 프로세스가 이 버전을 활성 버전으로 표시했다고 가정한다.
        fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.1.0' }))
        return response(checksum)
      }
      return response(bundle)
    }

    await assert.rejects(checkForUpdate({ fetchImpl, version: '1.0.0' }), /손상/)
    assert.equal(fs.readFileSync(path.join(destination, 'src', 'index.js'), 'utf8'), 'corrupted')
  })
})

test('a versions/<next> path that is a symlink/junction is refused instead of being deleted', async (t) => {
  await withStateDir(async (state) => {
    const files = {
      'package.json': JSON.stringify({ version: '1.1.0', type: 'module' }),
      'src/index.js': 'process.exit(0)',
    }
    const bundle = Buffer.from(JSON.stringify({ version: '1.1.0', files }))
    const checksum = createHash('sha256').update(bundle).digest('hex')
    const destination = path.join(state, 'versions', '1.1.0')
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-agent-symlink-target-'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    try {
      fs.symlinkSync(target, destination, 'junction')
    } catch (error) {
      if (error.code === 'EPERM') {
        fs.rmSync(target, { recursive: true, force: true })
        t.skip('symlink/junction creation not permitted')
        return
      }
      throw error
    }
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: '1.0.0' }))
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return response(JSON.stringify({ tag_name: 'v1.1.0', assets: [
        { name: 'dmw-agent-1.1.0.json', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json' },
        { name: 'dmw-agent-1.1.0.json.sha256', browser_download_url: 'https://github.com/name0825/dmw/releases/download/v1.1.0/dmw-agent-1.1.0.json.sha256' },
      ] }))
      if (url.endsWith('.json')) return response(bundle)
      return response(checksum)
    }

    try {
      await assert.rejects(checkForUpdate({ fetchImpl, version: '1.0.0' }), /심볼릭 링크/)
      assert.equal(fs.lstatSync(destination).isSymbolicLink(), true)
      assert.equal(fs.existsSync(target), true)
    } finally {
      fs.rmSync(destination, { force: true })
      fs.rmSync(target, { recursive: true, force: true })
    }
  })
})

const startServer = async (handler) => {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('requestJson throws HttpError with the response status for a non-JSON error body', async () => {
  const { server, url } = await startServer((request, result) => {
    result.writeHead(502, { 'Content-Type': 'text/html' })
    result.end('<html>Bad Gateway</html>')
  })
  try {
    await assert.rejects(requestJson(url), (error) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 502)
      return true
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('requestJson throws a clear error for an unparseable ok body', async () => {
  const { server, url } = await startServer((request, result) => {
    result.writeHead(200, { 'Content-Type': 'text/plain' })
    result.end('not json')
  })
  try {
    await assert.rejects(requestJson(url), (error) => {
      assert.ok(!(error instanceof HttpError))
      assert.match(error.message, /Invalid JSON/)
      return true
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

const runAgent = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [agentEntry, ...args], { env: { ...process.env, ...env }, stdio: 'ignore' })
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ child, code, signal }))
})

test('requestJson returns a literal JSON null ok body instead of treating it as invalid', async () => {
  const { server, url } = await startServer((request, result) => {
    result.writeHead(200, { 'Content-Type': 'application/json' })
    result.end('null')
  })
  try {
    assert.equal(await requestJson(url), null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('CLI unpair sends the stored key to the server and clears local credentials', async () => {
  await withStateDir(async (state) => {
    let authorization = ''
    const { server, url } = await startServer((request, result) => {
      authorization = String(request.headers.authorization || '')
      result.writeHead(200, { 'Content-Type': 'application/json' })
      result.end(JSON.stringify({ status: 'ok' }))
    })
    try {
      fs.writeFileSync(path.join(state, 'credentials.json'), JSON.stringify({ serverUrl: url, deviceId: 1, apiKey: 'stored-agent-key' }))
      const result = await runAgent(['--unpair'], { DMW_STATE_DIR: state })
      assert.equal(result.code, 0)
      assert.equal(authorization, 'Bearer stored-agent-key')
      assert.equal(fs.existsSync(path.join(state, 'credentials.json')), false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('running agent applies a replacement credential without restart', async () => {
  await withStateDir(async (state) => {
    const keys = []
    let resolveNewKey
    const newKeySeen = new Promise((resolve) => { resolveNewKey = resolve })
    const { server, url } = await startServer((request, result) => {
      keys.push(String(request.headers.authorization || ''))
      if (keys.at(-1) === 'Bearer replacement-key') resolveNewKey()
      result.writeHead(200, { 'Content-Type': 'application/json' })
      result.end(JSON.stringify({ status: 'ok' }))
    })
    const child = spawn(process.execPath, [agentEntry, '--background', '--interval', '1000', '--no-update'], { env: { ...process.env, DMW_STATE_DIR: state, DMW_STUB_METRICS: '1', NODE_ENV: 'test' }, stdio: 'ignore' })
    try {
      fs.writeFileSync(path.join(state, 'credentials.json'), JSON.stringify({ serverUrl: url, deviceId: 1, apiKey: 'initial-key' }))
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('initial heartbeat not received')), 5000)
        const wait = setInterval(() => {
          if (keys.includes('Bearer initial-key')) { clearTimeout(timeout); clearInterval(wait); resolve() }
        }, 20)
      })
      fs.writeFileSync(path.join(state, 'credentials.json'), JSON.stringify({ serverUrl: url, deviceId: 1, apiKey: 'replacement-key' }))
      await Promise.race([newKeySeen, new Promise((_, reject) => setTimeout(() => reject(new Error('replacement heartbeat not received')), 5000))])
    } finally {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit')), 10000)),
      ])
      await new Promise((resolve) => server.close(resolve))
    }
    assert.ok(keys.includes('Bearer initial-key'))
    assert.ok(keys.includes('Bearer replacement-key'))
  })
})

test('a saved/env heartbeat interval above the max is clamped instead of rejected', async () => {
  await withStateDir(async (state) => {
    const child = spawn(process.execPath, [agentEntry, '--background', '--no-update'], { env: { ...process.env, DMW_STATE_DIR: state, DMW_HEARTBEAT_INTERVAL_MS: '999999' }, stdio: 'ignore' })
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('settings.json not written')), 5000)
        const wait = setInterval(() => {
          if (fs.existsSync(path.join(state, 'settings.json'))) { clearTimeout(timeout); clearInterval(wait); resolve() }
        }, 20)
      })
      assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'settings.json'), 'utf8')).interval, 20000)
    } finally {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit')), 10000)),
      ])
    }
  })
})
