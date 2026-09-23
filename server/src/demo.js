// Demo mode (DEMO=1): seeds realistic data so the dashboard can be designed
// and demoed without an Apex or SCD41.

const HOUR = 3600 * 1000

// 30 days of hourly readings so the tap-for-trend charts have data.
// Daily sinusoids for temp/pH (lights cycle), slow wander for the rest,
// and a steady alkalinity decline that lands at the "current" low 7.3.
function seedHistory(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM tank_readings').get().n > 0) return
  const insert = db.prepare('INSERT INTO tank_readings (ts, param, value) VALUES (?, ?, ?)')
  const now = Date.now()
  const HOURS = 30 * 24
  const noise = (a) => (Math.random() - 0.5) * 2 * a
  const rows = []
  for (let h = HOURS; h >= 0; h--) {
    const ts = now - h * HOUR
    const t = HOURS - h
    const dayPhase = 2 * Math.PI * ((ts % 86400000) / 86400000)
    rows.push(
      [ts, 'temp', 78 + 0.5 * Math.sin(dayPhase - 1.8) + noise(0.12)],
      [ts, 'ph', 8.15 + 0.12 * Math.sin(dayPhase - 2.4) + noise(0.02)],
      [ts, 'salinity', 35 + 0.3 * Math.sin(t / 190) + noise(0.06)],
      [ts, 'alk', 8.6 - 1.3 * (t / HOURS) + noise(0.07)],
      [ts, 'ca', 425 + 8 * Math.sin(t / 130) + noise(3)],
      [ts, 'mg', 1320 + 15 * Math.sin(t / 300) + noise(5)],
      [ts, 'no3', 5 + 1.5 * Math.sin(t / 260) + noise(0.3)],
      [ts, 'po4', 0.06 + 0.02 * Math.sin(t / 170) + noise(0.005)]
    )
  }
  db.transaction(() => rows.forEach((r) => insert.run(...r)))()
}

export function seedDemo(state, db) {
  state.tank.latest = {
    temp: 78.1,
    ph: 8.24,
    salinity: 35.0,
    alk: 7.3, // deliberately below range to show the warning state
    ca: 428,
    mg: 1320,
    no3: 5.2,
    po4: 0.06
  }
  state.tank.inputs = Object.entries(state.tank.latest).map(([name, value]) => ({ name, type: 'demo', value }))
  state.tank.updatedAt = Date.now()

  state.environment = { ts: Date.now(), co2_ppm: 687, temp_c: 22.8, humidity_pct: 47 }

  seedHistory(db)

  // One ICP test, nine days old, mostly in range with a few that are not - so
  // the home screen's element tiles and the ICP screen have something to show.
  if (db.prepare('SELECT COUNT(*) AS n FROM icp_tests').get().n === 0) {
    const testId = db.prepare('INSERT INTO icp_tests (ts, lab, note) VALUES (?, ?, ?)')
      .run(Date.now() - 9 * 24 * HOUR, 'ATI', null).lastInsertRowid
    const put = db.prepare('INSERT INTO icp_results (test_id, element, value, unit) VALUES (?, ?, ?, ?)')
    for (const [el, value, unit] of [
      ['Ca', 428, 'mg/L'], ['Mg', 1320, 'mg/L'], ['K', 402, 'mg/L'], ['Sr', 8.4, 'mg/L'], ['B', 4.6, 'mg/L'],
      ['Br', 64, 'mg/L'], ['S', 905, 'mg/L'], ['F', 1.2, 'mg/L'], ['Li', 0.17, 'mg/L'], ['I', 22, 'µg/L'],
      ['Ba', 31, 'µg/L'], ['Mo', 11, 'µg/L'], ['Si', 180, 'µg/L'], ['Fe', 2.1, 'µg/L'], ['Mn', 1.2, 'µg/L'],
      ['Zn', 7.5, 'µg/L']
    ]) put.run(testId, el, value, unit)
  }

}
