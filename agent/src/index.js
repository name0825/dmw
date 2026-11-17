#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, resolvePairingInput } from './config.js'
import { loadCredentials, saveCredentials, clearCredentials, acquireLock, readState, writeState, getStateDir } from './credentials.js'
import { pairWithServer, sendHeartbeat, unpairFromServer } from './client.js'
import { collectMetrics, parseCollectSelection } from './metrics/index.js'
import { sleep, computeBackoffDelay } from './retry.js'
import { HttpError } from './http.js'
import { configureAutostart, ensureAutostart, installLauncher } from './autostart.js'
import { checkForUpdate, confirmActiveVersion } from './update.js'

const HELP_TEXT = `dmw-agent - DMW 장치 관리 에이전트

사용법: dmw-agent [옵션]
  --server <url>         서버 주소
  --code <code>          페어링 코드
  --name <name>          이 장치의 표시 이름
  --interval <ms>        heartbeat 주기 (기본 10000, 최소 1000, 최대 20000)
  --unpair               서버에서 페어링 해제 후 종료
  --repair, --reset      기존 서버에서 해제 후 새 서버에 페어링
  --force               해제 요청 실패 시 로컬 연결만 해제 (원격 키는 남을 수 있음)
  --enable-autostart     재부팅 후 사용자 로그인 시 자동실행 등록
  --disable-autostart    자동실행 해제
  --update               GitHub 최신 안정 릴리스 설치 후 종료
  --no-update            이번 실행에서 자동 업데이트 확인 생략 (웹의 업데이트 요청도 거부)
  -h, --help             도움말

첫 페어링 성공 시 로그인 자동실행을 등록합니다. Node.js 설치 경로를 유지하세요.
자동 업데이트는 시작 시와 6시간마다 확인합니다.
환경 변수: DMW_SERVER_URL, DMW_PAIRING_CODE, DMW_AGENT_NAME,
DMW_HEARTBEAT_INTERVAL_MS, DMW_STATE_DIR
`

const unpair = async (force = false) => {
  const cached = loadCredentials()
  if (!cached) return
  try { await unpairFromServer(cached.serverUrl, cached.apiKey) } catch (error) {
    if (!(error instanceof HttpError && [401, 403].includes(error.status))) {
      if (!force) throw error
      console.warn('서버에 연결할 수 없어 로컬 연결만 해제합니다. 기존 서버의 API 키는 폐기되지 않았을 수 있습니다.')
    }
  }
  clearCredentials(cached)
  console.log('메인서버 페어링을 해제했습니다.')
}

const ensureCredentials = async (args) => {
  if (!args.repair && loadCredentials()) return
  if (args.background) return
  const input = await resolvePairingInput({ server: args.server || process.env.DMW_SERVER_URL, code: args.code || process.env.DMW_PAIRING_CODE })
  const unlock = acquireLock('pairing')
  if (!unlock) throw new Error('다른 프로세스가 페어링을 변경하고 있습니다. 완료 후 다시 실행하세요.')
  try {
    if (args.repair) await unpair(args.force)
    else if (loadCredentials()) return
    const result = await pairWithServer(input.server, input.code, args.name || process.env.DMW_AGENT_NAME)
    saveCredentials({ serverUrl: input.server, deviceId: result.deviceId, apiKey: result.apiKey })
    console.log(`페어링 성공 (deviceId: ${result.deviceId})`)
    try { ensureAutostart(); console.log('자동실행 설정을 확인했습니다. 재부팅 후 사용자 로그인 시 실행됩니다.') } catch (error) { console.warn(`자동실행 등록 실패: ${error.message}. --enable-autostart로 다시 시도하세요.`) }
  } finally { unlock() }
}

const runHeartbeatLoop = async (intervalMs, noUpdate) => {
  const unlock = acquireLock('runtime')
  if (!unlock) { console.log('기존 에이전트가 실행 중입니다. 변경된 페어링을 자동으로 적용합니다.'); return }
  let running = true
  let lastHeartbeat = 0
  let lastKey
  let nextUpdate = 0
  let updateTask
  let consecutiveFailures = 0
  let nextDelay = intervalMs
  let confirmed = false
  let collect
  let pendingReport
  let requestedTask
  const runRequestedUpdate = async () => {
    if (noUpdate) {
      console.warn('--no-update로 실행 중이라 서버의 업데이트 요청을 거부합니다.')
      pendingReport = { state: 'failed', message: '에이전트가 --no-update로 실행 중이라 업데이트를 거부했습니다' }
      lastHeartbeat = 0
      return
    }
    pendingReport = { state: 'installing' }
    lastHeartbeat = 0
    try {
      await updateTask
      if (!running) return
      if (await checkForUpdate()) { console.log('업데이트 설치 완료. 새 버전으로 다시 시작합니다.'); process.exitCode = 75; running = false; return }
      pendingReport = { state: 'up_to_date', message: '새 업데이트가 없습니다' }
    } catch (error) {
      pendingReport = { state: 'failed', message: String(error.message).slice(0, 200) }
    }
    lastHeartbeat = 0
  }
  const stop = () => { running = false }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    while (running) {
      const credentials = loadCredentials()
      if (credentials && !noUpdate && Date.now() >= nextUpdate) {
        nextUpdate = Date.now() + 6 * 60 * 60 * 1000
        updateTask = checkForUpdate().then((updated) => {
          if (updated && running) { console.log('업데이트 설치 완료. 새 버전으로 다시 시작합니다.'); process.exitCode = 75; running = false }
        }).catch((error) => console.warn(`업데이트 확인 실패: ${error.message}. 현재 버전을 계속 사용합니다.`))
      }
      const keyChanged = credentials && credentials.apiKey !== lastKey
      if (credentials && (keyChanged || Date.now() - lastHeartbeat >= nextDelay)) {
        if (keyChanged) { consecutiveFailures = 0; nextDelay = intervalMs }
        lastHeartbeat = Date.now()
        lastKey = credentials.apiKey
        try {
          const metrics = await collectMetrics(collect)
          if (loadCredentials()?.apiKey === credentials.apiKey) {
            const sentReport = pendingReport
            const response = await sendHeartbeat(credentials.serverUrl, credentials.apiKey, metrics, sentReport)
            if (pendingReport === sentReport) pendingReport = undefined
            collect = parseCollectSelection(response) ?? collect
            if (response?.update === true && !requestedTask) {
              console.log('서버에서 업데이트를 요청했습니다.')
              requestedTask = runRequestedUpdate().finally(() => { requestedTask = undefined })
            }
            if (!confirmed) {
              confirmed = true
              try { confirmActiveVersion() } catch (confirmError) { console.warn(`[update] 활성 버전 확정 실패: ${confirmError.message}`) }
            }
          }
          consecutiveFailures = 0
          nextDelay = intervalMs
        } catch (error) {
          if (error instanceof HttpError && [401, 403].includes(error.status)) {
            const release = acquireLock('pairing')
            if (release) {
              try { clearCredentials(credentials) } catch (clearError) { console.warn(`[heartbeat] 로컬 인증 정보 삭제 실패: ${clearError.message}`) } finally { release() }
            }
            console.error('서버 인증이 해제되었습니다. --repair로 다시 페어링하세요.')
          } else {
            consecutiveFailures += 1
            nextDelay = computeBackoffDelay(intervalMs, consecutiveFailures)
            console.warn(`[heartbeat] 전송 실패 (재시도 ${consecutiveFailures}회, 다음 시도까지 약 ${Math.round(nextDelay / 1000)}초): ${error.message}`)
          }
        }
      }
      if (running) await sleep(1000)
    }
    await updateTask
    await requestedTask
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    unlock()
  }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP_TEXT); return }
  const state = getStateDir()
  process.env.DMW_STATE_DIR = state
  const active = readState('active.json')?.version
  const entry = active && /^\d+\.\d+\.\d+$/.test(active) ? path.join(state, 'versions', active, 'src/index.js') : null
  if (entry && fs.existsSync(entry) && path.resolve(entry) !== path.resolve(fileURLToPath(import.meta.url))) {
    const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
    await new Promise((resolve) => child.on('exit', (code) => { process.exitCode = code ?? 1; resolve() }))
    return
  }
  if (args.enableAutostart || args.disableAutostart) {
    configureAutostart(args.enableAutostart === true)
    console.log(args.enableAutostart ? '로그인 자동실행을 등록했습니다.' : '자동실행을 해제했습니다.')
    return
  }
  if (args.unpair) {
    const unlock = acquireLock('pairing')
    if (!unlock) throw new Error('다른 프로세스가 페어링을 변경하고 있습니다.')
    try { await unpair(args.force) } finally { unlock() }
    return
  }
  if (args.update) { installLauncher(); console.log(await checkForUpdate() ? '업데이트 설치 완료. 다음 실행에 적용됩니다.' : '새 업데이트가 없습니다.'); return }
  let interval = Number(args.interval || process.env.DMW_HEARTBEAT_INTERVAL_MS || readState('settings.json')?.interval || 10000)
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('heartbeat 주기는 1000ms 이상이어야 합니다.')
  if (interval > 20000) {
    console.warn(`heartbeat 주기는 최대 20000ms까지 지원합니다. 저장된 값(${interval}ms)을 20000ms로 조정합니다.`)
    interval = 20000
  }
  writeState('settings.json', { ...readState('settings.json'), interval })
  await ensureCredentials(args)
  if (readState('settings.json')?.autostart === true) {
    try { configureAutostart(true) } catch (error) { console.warn(`자동실행 갱신 실패: ${error.message}`) }
  } else installLauncher()
  await runHeartbeatLoop(interval, args.noUpdate)
  if (process.exitCode === 75 && !process.env.DMW_LAUNCHER) {
    process.exitCode = 0
    const child = spawn(process.execPath, [path.join(state, 'launcher.cjs')], { stdio: 'inherit', env: process.env })
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
    await new Promise((resolve) => child.on('exit', (code) => { process.exitCode = code ?? 1; resolve() }))
  }
}

main().catch((error) => { console.error('Agent error:', error.message); process.exitCode = 1 })
