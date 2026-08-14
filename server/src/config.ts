import 'dotenv/config'
import path from 'node:path'

const normalizeList = (value?: string) =>
  (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

export const PORT = Number(process.env.PORT || 3001)
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'dmw.db')
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dmw.local'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
export const CORS_ORIGIN = normalizeList(process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN)
export const APP_ENV = process.env.NODE_ENV || 'development'
