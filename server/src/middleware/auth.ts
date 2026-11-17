import { authMiddleware } from '../auth.js'

export const requireAdmin = async (request: any, reply: any) => {
  if (request.user?.role !== 'admin') {
    return reply.code(403).send({ message: 'Forbidden' })
  }
}

export { authMiddleware }
