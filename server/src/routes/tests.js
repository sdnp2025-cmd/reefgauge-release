// Tests done by hand.
//
// Not every reefer has a controller, and those who do rarely have a probe for
// everything: alkalinity, nitrate and phosphate are mostly still a test kit
// and a syringe. A number typed in here becomes a gauge and a point on the
// chart like any other - the dashboard should not care whether a probe or a
// person read the water.
//
// Two places hold each test. manual_tests is the record: kept for good, and
// what gets listed and deleted. tank_readings gets a copy so every existing
// chart draws it without knowing; that table is pruned by age, which is why
// it cannot be the record.
//
// A typed number colours its gauge but does not sound an alarm. An alarm that
// stays raised for a week because nobody has re-tested is noise, and noise is
// how real alarms get ignored.

import { PARAM_META } from '../config.js'

// Wider than any healthy tank, narrow enough to catch 82 typed as 820.
const PLAUSIBLE = {
  temp: [55, 100], ph: [6.5, 9.5], salinity: [15, 45], alk: [2, 20],
  ca: [150, 750], mg: [700, 2200], no3: [0, 250], po4: [0, 10]
}

// How long a hand test stays "recent". Past this the screen says it is due -
// a nudge on the tile, not an alarm.
export const TEST_EVERY_DAYS = { temp: 7, ph: 7, salinity: 14, alk: 7, ca: 14, mg: 14, no3: 7, po4: 7 }

/** The newest hand test per parameter: { alk: { value, ts }, ... } */
export function latestManual(db) {
  const rows = db.prepare(
    'SELECT param, value, ts FROM manual_tests m WHERE ts = (SELECT MAX(ts) FROM manual_tests WHERE param = m.param)'
  ).all()
  return Object.fromEntries(rows.map((r) => [r.param, { value: r.value, ts: r.ts }]))
}

export default async function testsRoutes(app, { db }) {
  app.get('/api/tests', async () => ({
    params: Object.fromEntries(Object.entries(PARAM_META).map(([k, m]) => [k, { ...m, everyDays: TEST_EVERY_DAYS[k] ?? 7 }])),
    latest: latestManual(db),
    recent: db.prepare('SELECT id, ts, param, value FROM manual_tests ORDER BY ts DESC LIMIT 40').all()
  }))

  app.post('/api/tests', async (req, reply) => {
    const param = String(req.body?.param ?? '')
    const value = Number(req.body?.value)
    if (!PARAM_META[param]) return reply.code(400).send({ error: 'unknown parameter' })
    if (!Number.isFinite(value)) return reply.code(400).send({ error: 'a number is required' })
    const [lo, hi] = PLAUSIBLE[param] ?? [-Infinity, Infinity]
    if (value < lo || value > hi) {
      return reply.code(400).send({
        error: `${value} does not look like a ${PARAM_META[param].label.toLowerCase()} reading${PARAM_META[param].unit ? ` in ${PARAM_META[param].unit}` : ''}. Check it and try again.`
      })
    }
    const ts = Number.isFinite(Number(req.body?.ts)) ? Number(req.body.ts) : Date.now()
    const info = db.prepare('INSERT INTO manual_tests (ts, param, value) VALUES (?, ?, ?)').run(ts, param, value)
    db.prepare('INSERT INTO tank_readings (ts, param, value) VALUES (?, ?, ?)').run(ts, param, value)
    // The same courtesy a water change gets: logging a test ticks the
    // maintenance task for testing, if there is one.
    try {
      db.prepare("UPDATE maint_tasks SET last_done = ? WHERE name LIKE '%test%' AND name NOT LIKE '%icp%'").run(ts)
    } catch { /* no such task */ }
    return { ok: true, id: info.lastInsertRowid }
  })

  app.delete('/api/tests/:id', async (req) => {
    const row = db.prepare('SELECT ts, param, value FROM manual_tests WHERE id = ?').get(Number(req.params.id))
    if (row) {
      db.prepare('DELETE FROM manual_tests WHERE id = ?').run(Number(req.params.id))
      db.prepare('DELETE FROM tank_readings WHERE ts = ? AND param = ? AND value = ?').run(row.ts, row.param, row.value)
    }
    return { ok: true }
  })
}
