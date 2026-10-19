import type { Database } from 'sqlite'

/**
 * DB 인스턴스 초기화 및 스키마 생성을 담당함.
 * 서버 시작 시마다 idempotently 실행되어 추가 테이블 생성 없이 안전함.
 */
export const initDb = async (db: Database): Promise<void> => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mac_address TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      agent_key_hash TEXT,
      agent_key_hint TEXT,
      agent_paired INTEGER NOT NULL DEFAULT 0,
      paired_at TEXT,
      last_seen TEXT,
      agent_version TEXT,
      status TEXT NOT NULL DEFAULT 'NOT_PAIRED',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- device_id 는 nullable 이다: 페어링 코드는 기기와 무관하게 먼저 발급되고,
      -- 에이전트가 코드를 소진하는 시점에 붙은 기기 id 가 기록된다 (감사 흔적).
      device_id INTEGER,
      -- target_device_id 는 발급 시점에 특정 기기로 지정된 코드에만 채워진다.
      -- 지정 없이 발급된 코드(신규 기기용)는 NULL 로 남는다.
      target_device_id INTEGER,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
      FOREIGN KEY(target_device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_metrics_latest (
      device_id INTEGER PRIMARY KEY,
      cpu_usage REAL,
      memory_usage REAL,
      disk_usage REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      lookup_id TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      replaced_by INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_metrics_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      cpu_usage REAL,
      memory_usage REAL,
      disk_usage REAL,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      level TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS command_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER,
      device_name TEXT,
      user_id INTEGER,
      command TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      stdout TEXT,
      stderr TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      user_id INTEGER,
      device_id INTEGER,
      old_username TEXT,
      old_port INTEGER,
      old_fingerprint TEXT,
      new_username TEXT,
      new_port INTEGER,
      new_fingerprint TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_command_runs_device_started ON command_runs(device_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_agent_key_hint ON devices(agent_key_hint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_lookup_id ON refresh_tokens(lookup_id);
    CREATE INDEX IF NOT EXISTS idx_metrics_history_device_time
      ON device_metrics_history(device_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `)

  await migrateSchema(db)
}

/**
 * 이미 생성된 DB 에 뒤늦게 추가된 컬럼을 채워 넣는다.
 * `CREATE TABLE IF NOT EXISTS` 는 기존 테이블을 건드리지 않으므로,
 * 컬럼 추가는 별도 ALTER TABLE 로 처리해야 한다.
 * @param db - SQLite DB 연결
 */
const migrateSchema = async (db: Database): Promise<void> => {
  const userColumns = await db.all<{ name: string }[]>('PRAGMA table_info(users)')
  if (!userColumns.some((column) => column.name === 'role')) {
    await db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`)
  }
  if (!userColumns.some((column) => column.name === 'token_version')) {
    await db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0')
  }

  const refreshColumns = await db.all<{ name: string }[]>('PRAGMA table_info(refresh_tokens)')
  if (!refreshColumns.some((column) => column.name === 'revoked_at')) {
    await db.exec('ALTER TABLE refresh_tokens ADD COLUMN revoked_at TEXT')
  }
  if (!refreshColumns.some((column) => column.name === 'replaced_by')) {
    await db.exec('ALTER TABLE refresh_tokens ADD COLUMN replaced_by INTEGER')
  }

  const deviceColumns = await db.all<{ name: string }[]>('PRAGMA table_info(devices)')
  if (!deviceColumns.some((column) => column.name === 'agent_version')) {
    await db.exec('ALTER TABLE devices ADD COLUMN agent_version TEXT')
  }
  if (!deviceColumns.some((column) => column.name === 'ssh_username')) {
    await db.exec('ALTER TABLE devices ADD COLUMN ssh_username TEXT')
  }
  if (!deviceColumns.some((column) => column.name === 'ssh_port')) {
    await db.exec('ALTER TABLE devices ADD COLUMN ssh_port INTEGER')
  }
  if (!deviceColumns.some((column) => column.name === 'ssh_host_key')) {
    await db.exec('ALTER TABLE devices ADD COLUMN ssh_host_key TEXT')
  }
  if (!deviceColumns.some((column) => column.name === 'ssh_host_ip')) {
    await db.exec('ALTER TABLE devices ADD COLUMN ssh_host_ip TEXT')
  }

  // 순서 주의: 테이블을 재생성하면 인덱스도 함께 사라지므로,
  // 유니크 인덱스 보장은 재생성 이후에 수행해야 한다.
  await ensurePairingCodesDeviceIdNullable(db)

  const pairingColumns = await db.all<{ name: string }[]>('PRAGMA table_info(pairing_codes)')
  if (!pairingColumns.some((column) => column.name === 'target_device_id')) {
    await db.exec('ALTER TABLE pairing_codes ADD COLUMN target_device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE')
  }

  await ensurePairingCodeUniqueIndex(db)
  await ensureDevicesMacAddressUniqueIndex(db)
}

/**
 * 구 스키마(`device_id INTEGER NOT NULL`)로 만들어진 DB 를 nullable 로 옮긴다.
 * SQLite 는 ALTER TABLE 로 NOT NULL 제약을 풀 수 없으므로 공식 권장 절차
 * (새 테이블 생성 → 행 복사 → DROP → RENAME)를 따른다.
 *
 * - 이미 nullable 이면(신규 DB, 두 번째 부팅 이후) 아무 것도 하지 않는다 → idempotent.
 * - 재생성 중에는 FK 를 끄고(PRAGMA foreign_keys 는 트랜잭션 밖에서만 적용된다),
 *   끝난 뒤 foreign_key_check 로 참조 무결성을 확인한 다음 원래 값으로 되돌린다.
 * - 여기서는 withTransaction 을 쓸 수 없다. initDb 는 풀 등록(getDb) 이전에
 *   호출되므로 연결을 직접 받아 BEGIN/COMMIT 한다.
 * @param db - SQLite DB 연결
 */
const ensurePairingCodesDeviceIdNullable = async (db: Database): Promise<void> => {
  const columns = await db.all<{ name: string; notnull: number }[]>('PRAGMA table_info(pairing_codes)')
  const deviceId = columns.find((column) => column.name === 'device_id')
  if (!deviceId || deviceId.notnull === 0) return

  const [fkState] = await db.all<{ foreign_keys: number }[]>('PRAGMA foreign_keys')
  const foreignKeysWereOn = Boolean(fkState?.foreign_keys)

  await db.exec('PRAGMA foreign_keys = OFF')
  try {
    await db.exec('BEGIN')
    try {
      await db.exec(`
        CREATE TABLE pairing_codes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id INTEGER,
          code TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
        );
      `)
      await db.exec(
        `INSERT INTO pairing_codes_new (id, device_id, code, expires_at, used_at, created_at)
           SELECT id, device_id, code, expires_at, used_at, created_at FROM pairing_codes`
      )
      await db.exec('DROP TABLE pairing_codes')
      await db.exec('ALTER TABLE pairing_codes_new RENAME TO pairing_codes')
      await db.exec('COMMIT')
    } catch (error) {
      await db.exec('ROLLBACK')
      throw error
    }

    const violations = await db.all('PRAGMA foreign_key_check(pairing_codes)')
    if (violations.length > 0) {
      console.warn(`pairing_codes migration left ${violations.length} dangling device_id reference(s)`)
    }
    console.info('Migrated pairing_codes.device_id to nullable')
  } finally {
    if (foreignKeysWereOn) await db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * pairing_codes(code) 에 UNIQUE 인덱스를 건다.
 * 예전 스키마에는 유일성 제약이 없어 기존 DB 에 중복 code 가 남아 있을 수 있고,
 * 그대로 인덱스를 만들면 initDb 가 throw 해 서버가 부팅되지 않는다. 그래서
 * (1) 이미 소진(used_at)되었거나 만료된 중복 행만 먼저 지우고 — 아직 유효한 코드는
 *     페어링에 쓰일 수 있으므로 임의로 지우지 않는다 —
 * (2) 그래도 중복이 남아 인덱스 생성이 실패하면 경고만 남기고 넘어간다.
 *     유일성은 부팅을 막을 만큼 중요하지 않고, 신규 DB 에서는 항상 성립한다.
 * @param db - SQLite DB 연결
 */
const ensurePairingCodeUniqueIndex = async (db: Database): Promise<void> => {
  await db.run(
    `DELETE FROM pairing_codes
      WHERE (used_at IS NOT NULL OR expires_at < ?)
        AND code IN (SELECT code FROM pairing_codes GROUP BY code HAVING COUNT(*) > 1)`,
    [new Date().toISOString()]
  )

  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_codes_code ON pairing_codes(code)')
  } catch (error) {
    console.warn(
      'Skipping unique index on pairing_codes(code): duplicate codes still present',
      error
    )
  }
}

/**
 * devices(mac_address) 에 UNIQUE 인덱스를 건다.
 * 예전 스키마에는 유일성 제약이 없어 기존 DB 에 중복 mac_address 가 남아 있을 수
 * 있고, 그대로 인덱스를 만들면 initDb 가 throw 해 서버가 부팅되지 않는다. 어느
 * 행을 남길지는 임의로 정할 수 없으므로(에이전트 페어링 이력이 걸려 있을 수
 * 있다) 중복 행을 지우지 않고, 인덱스 생성이 실패하면 경고만 남기고 넘어간다.
 * 신규 DB 에서는 항상 성립한다.
 * @param db - SQLite DB 연결
 */
const ensureDevicesMacAddressUniqueIndex = async (db: Database): Promise<void> => {
  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mac_address ON devices(mac_address)')
  } catch (error) {
    console.warn(
      'Skipping unique index on devices(mac_address): duplicate MAC addresses still present',
      error
    )
  }
}
