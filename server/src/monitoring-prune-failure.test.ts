import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-monitoring-prune-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { updateOfflineStates } = await import('./services/monitoring.js')

/** monitoring.ts 의 HISTORY_PRUNE_RETRY_MS 와 일치해야 함 (5 분). */
const HISTORY_PRUNE_RETRY_MS = 5 * 60 * 1000

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('a failed history prune retries after a short backoff instead of being skipped for a day or hammered every tick', async (t) => {
  await initPool()
  const db = getDb()

  // device_metrics_history 를 지운 DELETE 를 가로채어 첫 호출만 실패시키고,
  // 이후 호출은 실제로 통과시켜 "재시도 여부"를 호출 횟수로 관찰한다.
  let historyDeleteCalls = 0
  const originalRun = db.run.bind(db)
  db.run = (sql: string, ...rest: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('DELETE FROM device_metrics_history')) {
      historyDeleteCalls += 1
      if (historyDeleteCalls === 1) {
        return Promise.reject(new Error('Simulated DB failure'))
      }
    }
    return originalRun(sql, ...rest)
  }
  t.after(() => {
    db.run = originalRun
  })

  // mock.timers 는 기본적으로 Date.now() 를 0 부터 시작시키므로, 실제 현재 시각을
  // 명시적으로 넘겨야 HISTORY_PRUNE_INTERVAL_MS 조건이 첫 호출부터 정상적으로 참이 된다.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.after(() => t.mock.timers.reset())

  // 1) 첫 호출: lastHistoryPruneAt 이 0 이라 정리를 시도하지만 위 스텁이 실패시킨다.
  await updateOfflineStates()
  assert.equal(historyDeleteCalls, 1)

  // 2) 재시도 대기 시간(5 분)이 지나기 전에는 매 틱(10 초)마다 다시 두드리지 않아야 한다.
  t.mock.timers.tick(HISTORY_PRUNE_RETRY_MS - 1000)
  await updateOfflineStates()
  assert.equal(historyDeleteCalls, 1)

  // 3) 재시도 대기 시간이 지나면 (버그 있던 예전 동작처럼 24 시간을 꽉 채우지 않고) 다시 시도해야 한다.
  t.mock.timers.tick(2000)
  await updateOfflineStates()
  assert.equal(historyDeleteCalls, 2)
})
