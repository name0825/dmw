import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { autostartEntry, installLauncher } from '../src/autostart.js'
import { parseArgs } from '../src/config.js'
import { checkForUpdate, isNewerVersion, validateBundle } from '../src/update.js'
import { HttpError, requestJson } from '../src/http.js'

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
  assert.match(windows.content, /node\.exe/)
  assert.match(windows.content, /launcher\.cjs/)

  const mac = autostartEntry({ platform: 'darwin', home: '/Users/test', node: '/usr/local/bin/node', launcher: '/state/launcher.cjs' })
  assert.match(mac.file, /Users[\\/]test[\\/]Library[\\/]LaunchAgents[\\/]io\.dmw\.agent\.plist$/)
  assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(mac.content, /<string>\/state\/launcher\.cjs<\/string>/)

  const linux = autostartEntry({ platform: 'linux', home: '/home/test', node: '/usr/bin/node', launcher: '/state/launcher.cjs' })
  assert.match(linux.file, /home[\\/]test[\\/]\.config[\\/]autostart[\\/]dmw-agent\.desktop$/)
  assert.match(linux.content, /^\[Desktop Entry\]/)
  assert.match(linux.content, /Exec="\/usr\/bin\/node" "\/state\/launcher\.cjs"/)
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0' })
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0' })
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')), { version: '1.1.0' })
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
      assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'credentials.json'), 'utf8')), null)
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
    const child = spawn(process.execPath, [agentEntry, '--background', '--interval', '1000', '--no-update'], { env: { ...process.env, DMW_STATE_DIR: state }, stdio: 'ignore' })
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
      await new Promise((resolve) => child.once('exit', resolve))
      await new Promise((resolve) => server.close(resolve))
    }
    assert.ok(keys.includes('Bearer initial-key'))
    assert.ok(keys.includes('Bearer replacement-key'))
  })
})
