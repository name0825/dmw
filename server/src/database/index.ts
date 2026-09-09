import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

import { DB_PATH } from '../config.js'
import { initDb } from './schema.js'
import { ensureAdmin } from './auth.js'

let pool: any = null

// 트랜잭션 직렬화용 프라미스 체인 뮤텍스. withTransaction 참고.
let txChain: Promise<void> = Promise.resolve()

/**
 * SQLite DB 풀을 생성하고 초기화함.
 * 서버 시작 시 한 번만 호출되며, 이후 재사용됨.
 */
export const initPool = async (): Promise<any> => {
  if (pool) return pool

  // sqlite@5 의 driver 는 문자열이 아니라 생성자를 받는다. 문자열을 넘기면
  // "driver is not a constructor" 로 부팅 자체가 실패한다.
  // DB 파일이 처음 만들어질 때 상위 디렉터리가 없으면 SQLITE_CANTOPEN 이 나므로 먼저 만든다.
  await mkdir(path.dirname(DB_PATH), { recursive: true })
  const db = await sqlite.open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  }) as any
  await initDb(db)
  await ensureAdmin(db)
  pool = db

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
export const closePool = async (): Promise<void> => {
  const db = pool
  pool = null
  if (db) {
    await db.close()
  }
}

/**
 * 단일 트랜잭션을 실제로 실행한다. 잠금 처리는 `withTransaction` 이 담당한다.
 */
const runTransaction = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
  const db = getDb()
  await db.exec('BEGIN')
  try {
    const result = await fn(db)
    await db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      await db.exec('ROLLBACK')
    } catch (rollbackError) {
      // 롤백까지 실패하면 커넥션이 중단된 트랜잭션 상태에 갇힐 수 있다.
      // 복구는 시도하지 않고 흔적만 남긴다.
      console.error('Failed to roll back transaction:', rollbackError)
    }
    throw error
  }
}

/**
 * BEGIN → fn → COMMIT (예외 시 ROLLBACK 후 재던지기) 을 수행한다.
 * `pool` 은 이름과 달리 단일 커넥션이므로 트랜잭션이 겹치면
 * "cannot start a transaction within a transaction" 이 나거나
 * 한쪽 ROLLBACK 이 다른 쪽의 미커밋 쓰기를 날린다. 그래서 프라미스 체인으로
 * 트랜잭션을 한 번에 하나씩만 실행되도록 직렬화한다.
 *
 * 한계: 트랜잭션끼리만 직렬화하므로, 트랜잭션 밖의 단독 `db.run` 은 여전히 트랜잭션 도중에 끼어들 수 있다.
 */
export const withTransaction = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
  const result = txChain.then(() => runTransaction(fn))
  // 앞 작업의 실패가 대기 중인 다음 작업까지 죽이지 않도록 체인에서는 결과를 삼킨다.
  // (성공/실패 어느 쪽이든 잠금이 반드시 풀린다)
  txChain = result.then(() => undefined, () => undefined)
  return result
}
