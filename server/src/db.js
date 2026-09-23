import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export function initDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')   // the ICP results cascade depends on this
  db.exec(`
    CREATE TABLE IF NOT EXISTS tank_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      param TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tank_param_ts ON tank_readings(param, ts);

    CREATE TABLE IF NOT EXISTS env_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      co2_ppm REAL,
      temp_c REAL,
      humidity_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_env_ts ON env_readings(ts);

    CREATE TABLE IF NOT EXISTS maint_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      interval_days INTEGER NOT NULL,
      last_done INTEGER NOT NULL
    );

    -- The tank's written history. The controller says what the water is doing
    -- right now; these three say what was done to it, which is the half that
    -- makes a reading explicable. "Alk climbed on Tuesday" is a fact; "alk
    -- climbed after the doser went up on Tuesday" is a reason.
    CREATE TABLE IF NOT EXISTS dose_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      supplement TEXT NOT NULL,
      amount_ml REAL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dose_ts ON dose_log(ts);

    CREATE TABLE IF NOT EXISTS water_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      gallons REAL,
      salt TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wc_ts ON water_changes(ts);

    -- An ICP test is a header plus a row per element, rather than one wide
    -- row: labs report different element sets, and a schema with a column per
    -- element needs migrating every time one of them adds an assay.
    CREATE TABLE IF NOT EXISTS icp_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      lab TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_icp_ts ON icp_tests(ts);

    CREATE TABLE IF NOT EXISTS icp_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL REFERENCES icp_tests(id) ON DELETE CASCADE,
      element TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_icp_results_test ON icp_results(test_id, element);

    -- The coral journal. A tank's livestock is the part of it people are
    -- actually attached to, and the part no reading describes: a colony that
    -- doubled in a year and one that has not moved look identical in a
    -- parameter chart.
    CREATE TABLE IF NOT EXISTS corals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      species TEXT,
      source TEXT,
      added_at INTEGER,
      note TEXT,
      -- A coral that dies or is sold is not deleted. Losing the record loses
      -- the history that explains what happened, which is the one thing worth
      -- having afterwards.
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS coral_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coral_id INTEGER NOT NULL REFERENCES corals(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      file TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coral_photos ON coral_photos(coral_id, ts);
  `)
  seedMaintDefaults(db)
  return db
}

// Sensible reef-keeping defaults on a fresh database — editable via the API.
function seedMaintDefaults(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM maint_tasks').get().n > 0) return
  const insert = db.prepare('INSERT INTO maint_tasks (name, interval_days, last_done) VALUES (?, ?, ?)')
  const now = Date.now()
  const DAY = 24 * 3600 * 1000
  insert.run('Water change', 7, now - 5 * DAY)
  insert.run('Change filter sock', 4, now - 3 * DAY)
  insert.run('Clean skimmer cup', 7, now - 2 * DAY)
  insert.run('Trident reagent refill', 60, now - 45 * DAY)
  insert.run('Calibrate pH probe', 90, now - 30 * DAY)
}

const RETENTION_DAYS = 90

export function pruneOldReadings(db) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000
  db.prepare('DELETE FROM tank_readings WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM env_readings WHERE ts < ?').run(cutoff)
}
