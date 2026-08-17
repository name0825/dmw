// Barrel module — re-exports the shared SQLite connection and bootstrap helpers
// from the `db/` directory. Existing call sites such as
//   import { db } from './db.js'
//   import { ensureAdmin } from './db.js'
// continue to work without any changes.
export { db, ensureAdmin } from './db/index.js'
