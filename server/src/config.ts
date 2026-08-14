import 'dotenv/config'
import path from 'node:path'

const normalizeList = (value?: string) =>
  (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

export const APP_ENV = process.env.NODE_ENV || 'development'
export const PORT = Number(process.env.PORT || 3001)
export const JWT_SECRET = process.env.JWT_SECRET || (APP_ENV === 'production' ? '' : 'dev-secret')
export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'dmw.db')
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dmw.local'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (APP_ENV === 'production' ? '' : 'admin123')
export const CORS_ORIGIN = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)

export const validateRuntimeConfig = () => {
  const runtimeEnv = process.env.NODE_ENV || APP_ENV

  if (runtimeEnv !== 'production') return

  const runtimeJwtSecret = process.env.JWT_SECRET || JWT_SECRET
  const runtimeAdminPassword = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD

  if (!runtimeJwtSecret || runtimeJwtSecret === 'dev-secret') {
    throw new Error('JWT_SECRET must be set in production mode.')
  }

  if (!runtimeAdminPassword || runtimeAdminPassword === 'admin123') {
    throw new Error('ADMIN_PASSWORD must be set in production mode.')
  }
}
