import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmw-server-monitoring-transaction-test-'))
process.env.DB_PATH = path.join(databaseDirectory, 'dmw.db')

const { initPool, closePool, getDb } = await import('./database/index.js')
const { updateOfflineStates } = await import('./services/monitoring.js')

after(async () => {
  await closePool()
  fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test('offline evaluation reads device state inside its update transaction', async () => {
  await initPool()
  const db = getDb()
  const originalExec = db.exec.bind(db)
  const originalAll = db.all.bind(db)
  let transactionOpen = false
  let deviceReadInTransaction: boolean | undefined

  db.exec = async (sql: string) => {
    if (sql === 'BEGIN') transactionOpen = true
    const result = await originalExec(sql)
    if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionOpen = false
    return result
  }
  db.all = async (sql: string, params?: unknown) => {
    if (sql.startsWith('SELECT * FROM devices WHERE status IN')) {
      deviceReadInTransaction = transactionOpen
    }
    return await originalAll(sql, params)
  }

  try {
    await updateOfflineStates()
    assert.equal(deviceReadInTransaction, true)
  } finally {
    db.exec = originalExec
    db.all = originalAll
  }
})
