import { registerAuthRoutes } from './routes/auth.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerAgentRoutes } from './routes/agent.js'
import { monitorAlerts, updateOfflineStates } from './monitoring.js'

// 백그라운드 모니터링 주기 (10초)
const MONITOR_INTERVAL_MS = 10 * 1000

/**
 * 모든 HTTP 라우트를 등록한다.
 * 각 도메인(인증/기기/에이전트)은 routes/ 하위 모듈로 분리되어 있고,
 * 이 파일은 등록 오케스트레이션과 백그라운드 스케줄러만 담당한다.
 * @param {any} app - Fastify app 인스턴스
 */
export const registerRoutes = async (app: any) => {
  app.get('/health', async () => ({ status: 'ok' }))

  registerAuthRoutes(app)
  registerDeviceRoutes(app)
  registerAgentRoutes(app)

  // NOTE: 핸들러는 unref하지 않는다. 기존 동작상 서버 프로세스가
  // 스케줄러로 유지되는 것을 전제로 하며, 변경 시 프로세스 수명 주기가 바뀐다.
  setInterval(() => {
    updateOfflineStates().catch(() => undefined)
    monitorAlerts().catch(() => undefined)
  }, MONITOR_INTERVAL_MS)
}
