import { PAIRING_CODE_RATE_LIMIT_MAX, RATE_LIMIT_TIME_WINDOW } from '../config/constants.js'
import * as pairingService from '../services/pairing.js'

// ============================================================================
// Route registration (defines Fastify endpoints)
// ============================================================================

/**
 * Registers pairing code routes (admin side).
 * 이 라우트는 PUBLIC_ROUTE_PATHS 에 없으므로 인증된 관리자만 호출할 수 있다.
 * @param app - Fastify app instance
 */
export const registerPairingRoutes = (app: any) => {
  app.post('/pairing-codes', { config: { rateLimit: { max: PAIRING_CODE_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW } } }, async (request: any, reply: any) => {
    return await pairingService.handleCreatePairingCode(request, reply)
  })
}
