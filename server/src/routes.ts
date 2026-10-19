import { registerAuthRoutes } from './routes/auth.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerAgentRoutes } from './routes/agent.js'
import { registerPairingRoutes } from './routes/pairing.js'
import { registerSshRoutes } from './routes/ssh.js'
import { pruneCommandRuns } from './services/ssh.js'
import { pruneExpiredPairingCodes } from './services/pairing.js'
import { monitorAlerts, updateOfflineStates } from './services/monitoring.js'
import { pruneExpiredRefreshTokens } from './database/auth.js'
import { MONITOR_INTERVAL_MS } from './config/constants.js'

const PRUNE_INTERVAL_MS = 60 * 60 * 1000

let schedulerTimer: ReturnType<typeof setInterval> | undefined

/** 백그라운드 스케줄러(setInterval)를 중지한다. 종료 시 DB 를 닫기 전에 호출한다. */
export const stopScheduler = () => {
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = undefined
}

/**
 * 모든 HTTP 라우트를 등록한다.
 * 각 도메인(인증/기기/에이전트/페어링)은 routes/ 하위 모듈로 분리되어 있고,
 * 이 파일은 등록 오케스트레이션과 백그라운드 스케줄러만 담당한다.
 * @param {any} app - Fastify app 인스턴스
 */
export const registerRoutes = async (app: any) => {
  app.get('/health', async () => ({ status: 'ok' }))

  registerAuthRoutes(app)
  registerDeviceRoutes(app)
  registerAgentRoutes(app)
  registerPairingRoutes(app)
  registerSshRoutes(app)

  // NOTE: 핸들러는 unref하지 않는다. 기존 동작상 서버 프로세스가
  // 스케줄러로 유지되는 것을 전제로 하며, 변경 시 프로세스 수명 주기가 바뀐다.
  let lastPruneAt = 0
  schedulerTimer = setInterval(() => {
    // 루프는 계속 돌아야 하므로 다시 throw 하지 않지만, DB 장애 등이
    // 조용히 묻히지 않도록 로그는 반드시 남긴다.
    updateOfflineStates().catch((error) => {
      console.error('Error updating offline states:', error)
    })
    monitorAlerts().catch((error) => {
      console.error('Error monitoring alerts:', error)
    })
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now()
      pruneExpiredRefreshTokens().catch((error) => {
        console.error('Error pruning expired refresh tokens:', error)
      })
      pruneCommandRuns().catch((error) => {
        console.error('Error pruning command runs:', error)
      })
      pruneExpiredPairingCodes().catch((error) => {
        console.error('Error pruning pairing codes:', error)
      })
    }
  }, MONITOR_INTERVAL_MS)
}
