import readline from 'node:readline/promises'

export const parseArgs = (argv) => {
  const args = { repair: false, help: false }
  const values = { '--server': 'server', '--code': 'code', '--name': 'name', '--interval': 'interval' }
  const flags = { '--repair': 'repair', '--reset': 'repair', '--unpair': 'unpair', '--force': 'force', '--enable-autostart': 'enableAutostart', '--disable-autostart': 'disableAutostart', '--no-update': 'noUpdate', '--update': 'update', '--background': 'background', '--help': 'help', '-h': 'help' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (values[arg]) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`)
      args[values[arg]] = value
    } else if (flags[arg]) args[flags[arg]] = true
    else throw new Error(`알 수 없는 옵션: ${arg}`)
  }
  if (args.interval && (!Number.isFinite(Number(args.interval)) || Number(args.interval) < 1000 || Number(args.interval) > 20000)) throw new Error('--interval은 1000 이상 20000 이하의 밀리초여야 합니다.')
  if (args.enableAutostart && args.disableAutostart) throw new Error('자동실행 켜기/끄기를 동시에 지정할 수 없습니다.')
  if (args.unpair && args.repair) throw new Error('--unpair와 --repair를 동시에 지정할 수 없습니다.')
  if (args.force && !args.unpair && !args.repair) throw new Error('--force는 --unpair 또는 --repair와 함께 사용하세요.')
  return args
}

const normalizeServerUrl = (input) => {
  const trimmed = input.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('올바른 HTTP 서버 주소가 필요합니다.')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    console.error('경고: 서버 주소가 http://이므로 API 키가 평문으로 전송됩니다. https:// 사용을 권장합니다.')
  }
  return withScheme.replace(/\/+$/, '')
}

export const resolvePairingInput = async ({ server, code }) => {
  if (server && code) return { server: normalizeServerUrl(server), code }
  if (!process.stdin.isTTY) throw new Error('서버 주소/페어링 코드가 필요합니다. --server, --code 인자나 DMW_SERVER_URL, DMW_PAIRING_CODE 환경 변수를 지정하세요.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const resolvedServer = server || (await rl.question('서버 주소 (예: 192.168.0.10:3001): '))
    const resolvedCode = code || (await rl.question('페어링 코드: '))
    if (!resolvedServer.trim() || !resolvedCode.trim()) throw new Error('서버 주소와 페어링 코드를 입력하세요.')
    return { server: normalizeServerUrl(resolvedServer), code: resolvedCode }
  } finally { rl.close() }
}
