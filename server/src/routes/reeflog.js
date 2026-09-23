// The tank's written history: what was dosed, when water was changed, and what
// the lab found. The controller reports what the water is doing; this records
// what was done to it, which is the half that makes a reading explicable.

import fs from 'node:fs'
import { spawn } from 'node:child_process'

import { saveConfigAtomic } from '../config.js'

import { ELEMENTS, parsePaste, statusOf, severityOf, symbolFor } from '../icpReference.js'
import { DOSING_METHODS, DEFAULT_METHOD, allSupplements, methodFor } from '../dosingMethods.js'

const DAY = 24 * 3600 * 1000

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function text(v, max = 120) {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : null
}

// Lab reports arrive as PDFs. Rather than teach the terminal to read PDFs, hand
// the job to pdftotext, which has been doing it since 2005 — `-layout` keeps
// the columns roughly where the lab put them, which is what makes each line
// still contain its own element and its own number.
function pdfToText(buffer) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn('pdftotext', ['-layout', '-q', '-enc', 'UTF-8', '-', '-'])
    } catch (err) {
      return reject(Object.assign(new Error('pdftotext-missing'), { cause: err }))
    }
    const out = []
    let size = 0
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('pdftotext-timeout')) }, 20000)

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err.code === 'ENOENT' ? new Error('pdftotext-missing') : err)
    })
    proc.stdout.on('data', (chunk) => {
      size += chunk.length
      // A report is a few kilobytes of text. Anything past a megabyte is not a
      // report, and reading all of it into memory is how a phone upload takes
      // the server down.
      if (size > 1024 * 1024) { proc.kill('SIGKILL'); return }
      out.push(chunk)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !out.length) return reject(new Error(`pdftotext exited ${code}`))
      resolve(Buffer.concat(out).toString('utf8'))
    })
    proc.stdin.on('error', () => { /* killed above; close handles the rest */ })
    proc.stdin.end(buffer)
  })
}

// Only dates that cannot be read two ways. 12.08.2026 is the 12th of August to
// a German lab and the 8th of December to an American one, and a test filed
// under the wrong date moves a point on a trend line to somewhere it never
// was — worse than having no date, because it looks right. Everything
// ambiguous falls through to "today", which the person confirms anyway.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']

function findSampleDate(text) {
  const head = text.slice(0, 4000)

  const iso = head.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }

  const named = head.match(
    new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTHS.join('|')})\\s+(20\\d{2})\\b|\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'i')
  )
  if (named) {
    const day = Number(named[1] ?? named[5])
    const monthName = (named[2] ?? named[4] ?? '').toLowerCase()
    const year = Number(named[3] ?? named[6])
    const month = MONTHS.indexOf(monthName)
    if (month >= 0 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day)
      if (!Number.isNaN(d.getTime())) return d.getTime()
    }
  }
  return null
}

export default async function reefLogRoutes(app, { config, db }) {
  // ── dosing ───────────────────────────────────────────────────────────────

  app.get('/api/log/doses', async (req) => {
    const raw = req.query.days ?? 30
    const days = raw === 'all' ? null : Math.min(Math.max(Number(raw), 1), 4000)
    const rows = days == null
      ? db.prepare('SELECT * FROM dose_log ORDER BY ts DESC LIMIT 400').all()
      : db
        .prepare('SELECT * FROM dose_log WHERE ts >= ? ORDER BY ts DESC LIMIT 400')
        .all(Date.now() - days * DAY)
    return { doses: rows }
  })

  app.post('/api/log/doses', async (req, reply) => {
    const supplement = text(req.body?.supplement, 60)
    if (!supplement) return reply.code(400).send({ error: 'supplement required' })
    const amount = num(req.body?.amountMl)
    if (amount != null && (amount <= 0 || amount > 100000)) {
      return reply.code(400).send({ error: 'that amount does not look right' })
    }
    const ts = num(req.body?.ts) ?? Date.now()
    const info = db
      .prepare('INSERT INTO dose_log (ts, supplement, amount_ml, note) VALUES (?, ?, ?, ?)')
      .run(ts, supplement, amount, text(req.body?.note))
    return { ok: true, id: info.lastInsertRowid }
  })

  app.delete('/api/log/doses/:id', async (req) => {
    db.prepare('DELETE FROM dose_log WHERE id = ?').run(Number(req.params.id))
    return { ok: true }
  })

  // What gets dosed here, most-used first — so the quick-log buttons on the
  // terminal are this tank's supplements rather than a guess at a generic
  // reef's. A tank with nothing logged yet gets the common four.
  app.get('/api/log/supplements', async () => {
    const rows = db
      .prepare(
        `SELECT supplement, COUNT(*) AS uses, MAX(amount_ml) AS last_amount
         FROM dose_log GROUP BY supplement ORDER BY uses DESC, supplement LIMIT 8`
      )
      .all()
    // The bottles this household actually keeps, from the dosing method they
    // chose in setup. A Triton tank has four numbered parts and a Moonshiner
    // has a shelf of trace elements; neither is served by a list that says
    // "Alkalinity, Calcium, Magnesium, Trace".
    const method = methodFor(config)
    const primary = DOSING_METHODS[method].supplements ?? []
    const used = rows.map((r) => ({ name: r.supplement, amountMl: r.last_amount ?? null }))
    // Top up rather than replace. Returning only what has been logged meant
    // that logging your first dose deleted the buttons for the others — the
    // list got narrower the more the tank was used.
    const have = new Set(used.map((s) => s.name.toLowerCase()))
    const supplements = [...used, ...primary.filter((d) => !have.has(d.name.toLowerCase()))]
    return {
      supplements,
      method,
      // Everything else the method knows about, for the picker.
      more: allSupplements(method).filter(
        (d) => !supplements.some((s) => s.name.toLowerCase() === d.name.toLowerCase())
      ),
      seeded: used.length === 0
    }
  })

  // Daily totals per supplement. A dose is an event, but the question people
  // ask is a rate — "am I still putting in ten a day" — and that only appears
  // once the events are summed by day.
  app.get('/api/log/doses/series', async (req) => {
    // 'all' is the whole log. The chart offers it as a range, and a tank that
    // has been dosed for three years is exactly where the long view earns its
    // keep — a year of daily rows is a few thousand, which is nothing.
    const raw = req.query.days ?? 60
    const days = raw === 'all' ? null : Math.min(Math.max(Number(raw), 7), 4000)
    const rows = days == null
      ? db.prepare('SELECT ts, supplement, amount_ml FROM dose_log ORDER BY ts').all()
      : db
        .prepare('SELECT ts, supplement, amount_ml FROM dose_log WHERE ts >= ? ORDER BY ts')
        .all(Date.now() - days * DAY)

    const byName = new Map()
    for (const row of rows) {
      if (!byName.has(row.supplement)) {
        byName.set(row.supplement, { supplement: row.supplement, days: new Map(), lastTs: null, doses: 0 })
      }
      const entry = byName.get(row.supplement)
      // Local midnight, not UTC: a dose at 9pm belongs to the evening it
      // happened, not to tomorrow.
      const d = new Date(row.ts)
      d.setHours(0, 0, 0, 0)
      const key = d.getTime()
      entry.days.set(key, (entry.days.get(key) ?? 0) + (row.amount_ml ?? 0))
      entry.lastTs = row.ts
      entry.doses += 1
    }

    const now = Date.now()
    const series = [...byName.values()].map((e) => {
      const points = [...e.days.entries()].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value }))
      const sum = (window) => points
        .filter((p) => p.ts >= now - window * DAY)
        .reduce((a, p) => a + p.value, 0)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      return {
        supplement: e.supplement,
        points,
        doses: e.doses,
        lastTs: e.lastTs,
        todayMl: e.days.get(today.getTime()) ?? 0,
        // A seven-day average says whether the routine held, where a single
        // day says only whether you dosed this morning.
        avg7: Math.round((sum(7) / 7) * 10) / 10,
        avg30: Math.round((sum(30) / 30) * 10) / 10
      }
    }).sort((a, b) => b.doses - a.doses || a.supplement.localeCompare(b.supplement))

    return { series, days }
  })

  // Which dosing method the household runs. It decides the bottles on the
  // dosing screen and nothing else — the terminal records what was dosed, it
  // does not decide it.
  app.get('/api/log/dosing-method', async () => ({
    method: methodFor(config),
    methods: Object.entries(DOSING_METHODS).map(([id, m]) => ({
      id,
      name: m.name,
      title: m.title,
      tagline: m.tagline,
      note: m.note,
      bottles: (m.supplements ?? []).map((s) => s.name),
      extra: (m.more ?? []).length
    }))
  }))

  app.post('/api/log/dosing-method', async (req, reply) => {
    const method = String(req.body?.method ?? '')
    if (!DOSING_METHODS[method]) return reply.code(400).send({ error: 'unknown dosing method' })
    config.dosing = { ...config.dosing, method }

    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.dosing = { ...onDisk.dosing, method }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }
    return { ok: true, method, persisted }
  })

  // ── water changes ────────────────────────────────────────────────────────

  app.get('/api/log/water', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200)
    const changes = db.prepare('SELECT * FROM water_changes ORDER BY ts DESC LIMIT ?').all(limit)
    // The interval the household actually set, from the maintenance task, so
    // "overdue" means overdue against their schedule rather than against a
    // number this file invented.
    const task = db
      .prepare("SELECT interval_days FROM maint_tasks WHERE name LIKE '%water change%' LIMIT 1")
      .get()
    return { changes, intervalDays: task?.interval_days ?? 7 }
  })

  app.post('/api/log/water', async (req, reply) => {
    const gallons = num(req.body?.gallons)
    if (gallons != null && (gallons <= 0 || gallons > 10000)) {
      return reply.code(400).send({ error: 'that volume does not look right' })
    }
    const ts = num(req.body?.ts) ?? Date.now()
    const info = db
      .prepare('INSERT INTO water_changes (ts, gallons, salt, note) VALUES (?, ?, ?, ?)')
      .run(ts, gallons, text(req.body?.salt, 60), text(req.body?.note))

    // A water change is also the maintenance task everyone forgets to tick.
    // Logging one here marks it done there, rather than asking for the same
    // fact twice on the same screen.
    try {
      db.prepare("UPDATE maint_tasks SET last_done = ? WHERE name LIKE '%water change%'").run(ts)
    } catch { /* the task may have been renamed or deleted */ }

    return { ok: true, id: info.lastInsertRowid }
  })

  app.delete('/api/log/water/:id', async (req) => {
    db.prepare('DELETE FROM water_changes WHERE id = ?').run(Number(req.params.id))
    return { ok: true }
  })

  // ── ICP ──────────────────────────────────────────────────────────────────

  const resultsFor = db.prepare('SELECT element, value, unit FROM icp_results WHERE test_id = ?')

  const withResults = (test) => ({
    ...test,
    results: resultsFor.all(test.id).map((r) => ({ ...r, status: statusOf(r.element, r.value), severity: severityOf(r.element, r.value) }))
  })

  app.get('/api/log/icp', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 12), 1), 60)
    const tests = db.prepare('SELECT * FROM icp_tests ORDER BY ts DESC LIMIT ?').all(limit)
    return { tests: tests.map(withResults), reference: ELEMENTS }
  })

  // One series per element, oldest first, for the trend chart. Only elements
  // this tank has actually been tested for — an axis for an element no lab
  // ever reported is an axis about nothing.
  app.get('/api/log/icp/series', async () => {
    const rows = db
      .prepare(
        `SELECT t.ts AS ts, r.element AS element, r.value AS value, r.unit AS unit
         FROM icp_results r JOIN icp_tests t ON t.id = r.test_id
         ORDER BY t.ts`
      )
      .all()
    const byElement = new Map()
    for (const row of rows) {
      if (!byElement.has(row.element)) {
        byElement.set(row.element, {
          element: row.element,
          name: ELEMENTS[row.element]?.name ?? row.element,
          unit: row.unit ?? ELEMENTS[row.element]?.unit ?? '',
          kind: ELEMENTS[row.element]?.kind ?? 'trace',
          low: ELEMENTS[row.element]?.low ?? null,
          high: ELEMENTS[row.element]?.high ?? null,
          points: []
        })
      }
      byElement.get(row.element).points.push({ ts: row.ts, value: row.value })
    }
    const order = { major: 0, minor: 1, trace: 2, watch: 3 }
    const series = [...byElement.values()].sort(
      (a, b) => (order[a.kind] - order[b.kind]) || a.element.localeCompare(b.element)
    )
    return { series }
  })

  // Reads a PDF and says what it found — and saves nothing. The saving is a
  // second, deliberate request, because a table PDF whose columns did not
  // survive extraction produces plausible numbers attached to the wrong
  // elements, and that is worse than a failed import: it looks right.
  app.post('/api/log/icp/extract', async (req, reply) => {
    const part = await req.file().catch(() => null)
    if (!part) return reply.code(400).send({ error: 'No file arrived.' })

    const name = part.filename ?? 'report.pdf'
    const looksPdf = /\.pdf$/i.test(name) || part.mimetype === 'application/pdf'
    if (!looksPdf) {
      part.file.resume()
      return reply.code(400).send({ error: `${name} is not a PDF. Paste the numbers instead.` })
    }

    let buffer
    try {
      buffer = await part.toBuffer()
    } catch (err) {
      return reply.code(400).send({
        error: /too large|limit/i.test(String(err.message)) ? 'That file is bigger than 25 MB.' : 'That file could not be read.'
      })
    }

    let text
    try {
      text = await pdfToText(buffer)
    } catch (err) {
      if (err.message === 'pdftotext-missing') {
        return reply.code(501).send({
          error: 'This terminal cannot read PDFs yet. Paste the numbers instead, or install poppler-utils.'
        })
      }
      return reply.code(422).send({ error: 'That PDF could not be read. Paste the numbers instead.' })
    }

    const { results, skipped } = parsePaste(text)
    if (!results.length) {
      // A scan with no text layer extracts to nothing at all, and that is a
      // different problem from a report we could read but not understand.
      return reply.code(422).send({
        error: text.trim().length < 40
          ? 'That PDF has no text in it — it is probably a scan. Paste the numbers instead.'
          : 'Nothing in that PDF looked like an element and a number.',
        skipped: skipped.slice(0, 12)
      })
    }

    return {
      ok: true,
      file: name,
      date: findSampleDate(text),
      results: results.map((r) => ({ ...r, status: statusOf(r.element, r.value), severity: severityOf(r.element, r.value), name: ELEMENTS[r.element]?.name ?? r.element })),
      skipped: skipped.slice(0, 20)
    }
  })

  // Accepts either a parsed list or the text of a lab report pasted straight
  // in. The paste path is the one that matters: nobody is typing thirty
  // elements into an on-screen keyboard, and every lab hands you a table.
  app.post('/api/log/icp', async (req, reply) => {
    const ts = num(req.body?.ts) ?? Date.now()
    const lab = text(req.body?.lab, 40)
    const note = text(req.body?.note)

    let results = []
    let skipped = []
    if (typeof req.body?.paste === 'string' && req.body.paste.trim()) {
      ;({ results, skipped } = parsePaste(req.body.paste))
    } else if (Array.isArray(req.body?.results)) {
      for (const r of req.body.results) {
        const element = symbolFor(r?.element)
        const value = num(r?.value)
        if (!element || value == null) { skipped.push(String(r?.element ?? '?')); continue }
        results.push({ element, value, unit: ELEMENTS[element].unit })
      }
    }

    if (!results.length) {
      return reply.code(400).send({
        error: 'Nothing in that looked like an element and a number.',
        skipped: skipped.slice(0, 12)
      })
    }

    const insertTest = db.prepare('INSERT INTO icp_tests (ts, lab, note) VALUES (?, ?, ?)')
    const insertResult = db.prepare(
      'INSERT INTO icp_results (test_id, element, value, unit) VALUES (?, ?, ?, ?)'
    )
    // One transaction: a half-imported test is worse than none, because it
    // looks complete and quietly moves every trend line it touches.
    const save = db.transaction(() => {
      const id = insertTest.run(ts, lab, note).lastInsertRowid
      for (const r of results) insertResult.run(id, r.element, r.value, r.unit)
      return id
    })
    const id = save()

    return {
      ok: true,
      id,
      imported: results.length,
      skipped: skipped.slice(0, 12),
      results: results.map((r) => ({ ...r, status: statusOf(r.element, r.value), severity: severityOf(r.element, r.value) }))
    }
  })

  app.delete('/api/log/icp/:id', async (req) => {
    db.prepare('DELETE FROM icp_tests WHERE id = ?').run(Number(req.params.id))
    return { ok: true }
  })

  // ── events, for the trend charts ─────────────────────────────────────────

  // Doses and water changes in one list, so a chart that wants to mark them
  // makes one request instead of two and gets them already in order. The
  // window matches the chart's own, because an event outside the axis is an
  // event that cannot be drawn.
  app.get('/api/log/events', async (req) => {
    const hours = Math.min(Math.max(Number(req.query.hours ?? 168), 1), 24 * 400)
    const since = Date.now() - hours * 3600 * 1000

    const doses = db
      .prepare('SELECT id, ts, supplement, amount_ml FROM dose_log WHERE ts >= ? ORDER BY ts')
      .all(since)
      .map((d) => ({
        id: `d${d.id}`,
        ts: d.ts,
        kind: 'dose',
        label: d.supplement,
        detail: d.amount_ml != null ? `${d.amount_ml} ml` : null
      }))

    const water = db
      .prepare('SELECT id, ts, gallons, salt FROM water_changes WHERE ts >= ? ORDER BY ts')
      .all(since)
      .map((w) => ({
        id: `w${w.id}`,
        ts: w.ts,
        kind: 'water',
        label: 'Water change',
        detail: w.gallons != null ? `${w.gallons} gal` : w.salt
      }))

    return { events: [...doses, ...water].sort((a, b) => a.ts - b.ts) }
  })

  // ── the home card ────────────────────────────────────────────────────────

  app.get('/api/log/summary', async () => {
    const lastWater = db.prepare('SELECT * FROM water_changes ORDER BY ts DESC LIMIT 1').get() ?? null
    const since = Date.now() - DAY
    const today = db
      .prepare(
        `SELECT supplement, SUM(amount_ml) AS ml, COUNT(*) AS n
         FROM dose_log WHERE ts >= ? GROUP BY supplement ORDER BY ml DESC`
      )
      .all(since)
    const lastTest = db.prepare('SELECT * FROM icp_tests ORDER BY ts DESC LIMIT 1').get() ?? null

    // The point of an ICP test is the handful of numbers that came back wrong,
    // so the card carries those rather than a count of the thirty that didn't.
    let flagged = []
    if (lastTest) {
      flagged = resultsFor
        .all(lastTest.id)
        .map((r) => ({ ...r, status: statusOf(r.element, r.value), severity: severityOf(r.element, r.value) }))
        .filter((r) => r.status === 'low' || r.status === 'high')
        .sort((a, b) => (ELEMENTS[a.element]?.kind === 'watch' ? -1 : 0) - (ELEMENTS[b.element]?.kind === 'watch' ? -1 : 0))
    }

    return {
      lastWaterChange: lastWater,
      dosedToday: today,
      lastIcp: lastTest ? { ...lastTest, flagged } : null
    }
  })
}
