// Tank care: shared timers (water changes, dosing waits), maintenance
// reminders, and the Apex feed-mode trigger.

import { startFeedCycle } from '../pollers/apex.js'

const DAY = 24 * 3600 * 1000

export default async function careRoutes(app, { config, state, db }) {
  // ---- Kitchen timers (shared across every screen/phone) ----
  let timerSeq = 1
  state.timers = []

  app.get('/api/timers', async () => {
    state.timers = state.timers.filter((t) => t.endsAt > Date.now() - 10 * 60 * 1000)
    return { timers: state.timers }
  })

  app.post('/api/timers', async (req, reply) => {
    const seconds = Number(req.body?.seconds)
    if (!(seconds > 0 && seconds <= 24 * 3600)) return reply.code(400).send({ error: 'seconds must be 1..86400' })
    const timer = {
      id: timerSeq++,
      label: req.body?.label ?? null,
      endsAt: Date.now() + seconds * 1000,
      seconds
    }
    state.timers.push(timer)
    return timer
  })

  app.delete('/api/timers/:id', async (req) => {
    state.timers = state.timers.filter((t) => t.id !== Number(req.params.id))
    return { ok: true }
  })

  app.delete('/api/timers', async () => {
    const n = state.timers.length
    state.timers = []
    return { canceled: n }
  })

  // ---- Maintenance reminders ----
  app.get('/api/maint', async () => ({
    tasks: db.prepare('SELECT * FROM maint_tasks ORDER BY (last_done + interval_days * 86400000)').all()
      .map((t) => ({
        ...t,
        dueInDays: Math.round((t.last_done + t.interval_days * DAY - Date.now()) / DAY)
      }))
  }))

  app.post('/api/maint/:id/done', async (req, reply) => {
    const info = db.prepare('UPDATE maint_tasks SET last_done = ? WHERE id = ?').run(Date.now(), req.params.id)
    if (!info.changes) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  })

  app.post('/api/maint', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim()
    const days = Number(req.body?.interval_days)
    if (!name || !(days > 0)) return reply.code(400).send({ error: 'name and interval_days required' })
    db.prepare('INSERT INTO maint_tasks (name, interval_days, last_done) VALUES (?, ?, ?)').run(name, days, Date.now())
    return { ok: true }
  })

  app.delete('/api/maint/:id', async (req) => {
    db.prepare('DELETE FROM maint_tasks WHERE id = ?').run(req.params.id)
    return { ok: true }
  })

  // ---- Apex feed mode ----
  app.post('/api/tank/feed', async (req, reply) => {
    const minutes = config.apex?.feedMinutes ?? 5
    if (!process.env.DEMO) {
      try {
        await startFeedCycle(config.apex, config.apex?.feedCycle ?? 'A')
      } catch (err) {
        return reply.code(502).send({ error: String(err.message ?? err) })
      }
    }
    state.tank.feedUntil = Date.now() + minutes * 60 * 1000
    return { ok: true, feedUntil: state.tank.feedUntil }
  })

}
