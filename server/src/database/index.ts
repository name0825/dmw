import sqlite from 'sqlite'
import { initDb } from './schema.js'
import { ensureAdmin } from './auth.js'

let pool: any = null

/**
 * SQLite DB 풀을 생성하고 초기화함.
 * 서버 시작 시 한 번만 호출되며, 이후 재사용됨.
 */
export const initPool = (): any => {
  if (pool) return pool

  pool = sqlite.open(process.env.DB_PATH || 'data/dmw.db') as any

  pool.addListener('open', async () => {
    await initDb(pool)
    await ensureAdmin(pool)
  })

  return pool
}

/**
 * DB 연결을 반환함. 기존 call site 의 `import { db } from './db.js'`는 이 함수를 호출하여 연결을 얻음.
 */
export const getDb = (): any => {
  if (!pool) throw new Error('DB pool not initialized')
  return pool
}

/**
 * DB 연결을 안전하게 종료함. 서버 종료 시 호출됨.
 */
export const closePool = (): void => {
  if (pool) {
    pool.close()
    pool = null
  }
}
