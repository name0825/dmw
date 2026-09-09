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
  fs.writeFileSync(launcher, `const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
const state = __dirname; process.env.DMW_STATE_DIR = state; process.env.DMW_LAUNCHER = '1';
const fallback = ${JSON.stringify(path.join(root, 'src/index.js'))};
function start() {
  let entry = fallback;
  try { const active = JSON.parse(fs.readFileSync(path.join(state, 'active.json'), 'utf8')); if (/^\\d+\\.\\d+\\.\\d+$/.test(active.version)) entry = path.join(state, 'versions', active.version, 'src/index.js'); } catch {}
  const child = spawn(process.execPath, [entry, '--background'], { stdio: 'inherit', env: process.env, windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1 });
  child.on('exit', code => { if (code === 75) start(); else process.exitCode = code ?? 1 });
}
start();
`)
  return launcher
}
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export const autostartEntry = ({ platform = process.platform, home = os.homedir(), appData = process.env.APPDATA, node = process.execPath, launcher }) => {
  if (platform === 'win32') {
    if (!appData) throw new Error('APPDATA가 없어 자동실행을 등록할 수 없습니다.')
    const quote = (value) => `"${value.replaceAll('"', '""')}"`
    return { file: path.join(appData, 'Microsoft/Windows/Start Menu/Programs/Startup/DMW Agent.vbs'), content: `Set shell = CreateObject("WScript.Shell")\r\nshell.Run ${quote(`"${node}" "${launcher}"`)}, 0, False\r\n` }
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

