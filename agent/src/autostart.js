import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getStateDir, readState, writeState } from './credentials.js'

export const installLauncher = () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const state = getStateDir()
  fs.mkdirSync(state, { recursive: true })
  const launcher = path.join(state, 'launcher.cjs')
  let bundled = path.join(root, 'src/index.js')
  if (path.dirname(root) === path.resolve(state, 'versions')) {
    const saved = readState('bundled.json')?.entry
    if (saved && fs.existsSync(saved)) bundled = saved
    else {
      try {
        const previous = JSON.parse(/^const fallback = (".*");$/m.exec(fs.readFileSync(launcher, 'utf8'))[1])
        if (!path.resolve(previous).startsWith(path.resolve(state, 'versions') + path.sep) && fs.existsSync(previous)) bundled = previous
      } catch {}
    }
  } else writeState('bundled.json', { entry: bundled })
  fs.writeFileSync(launcher, `const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
const state = __dirname; process.env.DMW_STATE_DIR = state; process.env.DMW_LAUNCHER = '1';
const fallback = ${JSON.stringify(bundled)};
const semver = /^\\d+\\.\\d+\\.\\d+$/;
const base = Number(process.env.DMW_RESTART_DELAY_MS) || 1000;
const read = name => { try { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')) } catch { return null } };
const write = (name, value) => { const file = path.join(state, name); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file) };
let failures = 0, failedVersion = null, child = null, timer = null, stopping = false;
const rollback = active => {
  write('rollback.json', { version: active.version });
  if (semver.test(active.previous) && fs.existsSync(path.join(state, 'versions', active.previous, 'src/index.js'))) write('active.json', { version: active.previous });
  else fs.rmSync(path.join(state, 'active.json'), { force: true });
  console.error('새 버전 ' + active.version + ' 이(가) 반복 실패하여 이전 버전으로 되돌립니다.');
};
function start() {
  const active = read('active.json');
  const startedVersion = active && semver.test(active.version) ? active.version : null;
  const entry = startedVersion ? path.join(state, 'versions', startedVersion, 'src/index.js') : fallback;
  const startedAt = Date.now();
  let done = false;
  const finish = code => {
    if (done) return;
    done = true; child = null;
    if (code === 0) { process.exitCode = 0; return }
    if (stopping) { process.exitCode = code === 75 ? 0 : code ?? 1; return }
    if (code === 75) { failures = 0; start(); return }
    failures = Date.now() - startedAt >= 300000 || startedVersion !== failedVersion ? 1 : failures + 1;
    failedVersion = startedVersion;
    const current = read('active.json');
    if (current && current.pending && current.version === startedVersion && failures >= 3) { rollback(current); failures = 0; start(); return }
    timer = setTimeout(start, Math.min(base * 2 ** (failures - 1), 60000));
  };
  child = spawn(process.execPath, [entry, '--background'], { stdio: 'inherit', env: process.env, windowsHide: true });
  child.on('error', error => { console.error(error); finish(null) });
  child.on('exit', finish);
}
const stop = signal => { stopping = true; clearTimeout(timer); if (child) child.kill(signal) };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
start();
`)
  return launcher
}
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export const autostartEntry = ({ platform = process.platform, home = os.homedir(), appData = process.env.APPDATA, node = process.execPath, launcher }) => {
  if (platform === 'win32') {
    if (!appData) throw new Error('APPDATA가 없어 자동실행을 등록할 수 없습니다.')
    const quote = (value) => `"${value.replaceAll('"', '""')}"`
    return { file: path.join(appData, 'Microsoft/Windows/Start Menu/Programs/Startup/DMW Agent.vbs'), content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Set shell = CreateObject("WScript.Shell")\r\nshell.Run ${quote(`"${node}" "${launcher}"`)}, 0, False\r\n`, 'utf16le')]) }
  }
  if (platform === 'darwin') return { file: path.join(home, 'Library/LaunchAgents/io.dmw.agent.plist'), content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>io.dmw.agent</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n` }
  if (platform === 'linux') {
    const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`
    return { file: path.join(home, '.config/autostart/dmw-agent.desktop'), content: `[Desktop Entry]\nType=Application\nName=DMW Agent\nExec=${quote(node)} ${quote(launcher)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n` }
  }
  throw new Error(`자동실행을 지원하지 않는 OS: ${platform}`)
}
export const configureAutostart = (enabled) => {
  const launcher = installLauncher()
  const entry = autostartEntry({ launcher })
  fs.mkdirSync(path.dirname(entry.file), { recursive: true })
  if (enabled) fs.writeFileSync(entry.file, entry.content, { mode: 0o600 })
  else if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file)
  writeState('settings.json', { ...readState('settings.json'), autostart: enabled })
}
export const ensureAutostart = () => {
  if (readState('settings.json')?.autostart === false) return
  configureAutostart(true)
}

