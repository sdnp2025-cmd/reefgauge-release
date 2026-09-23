import fs from 'node:fs'
import path from 'node:path'
import { PARAM_META, saveConfigAtomic } from '../config.js'
import { PHOTO_EXTENSIONS, CONVERTED_EXTENSIONS, processPhoto } from '../photoIntake.js'
import { isLocalRequest } from '../phoneSession.js'
import { getRingSnapshot } from '../pollers/ring.js'
import { SOUNDS, playTone, alarmConfig } from '../alarmSound.js'
import { sendNtfy } from '../alerts.js'

// Free, embeddable live radar (Weather Underground and most weather sites
// forbid iframe embedding; Windy's embed is built for it).
function radarUrl(weather) {
  if (weather.radarUrl) return weather.radarUrl
  const { latitude: lat, longitude: lon } = weather
  return `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}` +
    '&zoom=8&level=surface&overlay=radar&menu=&message=true&calendar=now&type=map' +
    '&location=coordinates&metricWind=mph&metricTemp=%C2%B0F'
}

export default async function apiRoutes(app, { config, state, db }) {
  const photosDir = path.join(path.dirname(config.db), 'photos')
  fs.mkdirSync(photosDir, { recursive: true })
  // ---- Ranges ----
  //
  // The numbers every alarm on this terminal is measured against, and until
  // now the only config with no way to change them: not an endpoint, not a
  // screen, only hand-editing config.json over SSH. A customer who keeps their
  // tank at 1.024 rather than 1.026 had no way to stop it telling them they
  // were wrong twice a day.
  //
  // alerts.js reads config.ranges at evaluation time, so a change takes effect
  // on the next check with nothing to restart.

  // Generous bounds - wide enough for anyone's husbandry, narrow enough to
  // catch a misplaced decimal. That matters more here than anywhere else in
  // the config: a temperature range typed as 770-790 does not look obviously
  // wrong in a form, and it silently disables the alarm that protects the
  // livestock. Refusing is the kind thing to do.
  const RANGE_LIMITS = {
    temp: [60, 95], ph: [6.5, 9], salinity: [25, 40], alk: [4, 16],
    ca: [250, 600], mg: [900, 2000], no3: [0, 100], po4: [0, 2]
  }

  const rangesView = () => Object.fromEntries(
    Object.keys(PARAM_META).map((k) => [k, {
      ...PARAM_META[k],
      range: config.ranges?.[k] ?? null,
      limits: RANGE_LIMITS[k]
    }])
  )

  app.get('/api/ranges', async () => ({ ranges: rangesView() }))

  app.post('/api/ranges', async (req, reply) => {
    const patch = {}
    for (const [key, value] of Object.entries(req.body ?? {})) {
      if (!(key in PARAM_META)) return reply.code(400).send({ error: `unknown parameter "${key}"` })
      if (!Array.isArray(value) || value.length !== 2) {
        return reply.code(400).send({ error: `${key} needs a low and a high, as [low, high]` })
      }
      const [low, high] = value.map(Number)
      if (!Number.isFinite(low) || !Number.isFinite(high)) {
        return reply.code(400).send({ error: `${key} needs two numbers` })
      }
      if (low >= high) {
        return reply.code(400).send({ error: `${key}: the low (${low}) must be below the high (${high})` })
      }
      const [min, max] = RANGE_LIMITS[key]
      if (low < min || high > max) {
        return reply.code(400).send({
          error: `${key} must sit between ${min} and ${max} ${PARAM_META[key].unit}`.trim()
        })
      }
      patch[key] = [low, high]
    }
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'nothing to change' })

    config.ranges = { ...config.ranges, ...patch }

    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.ranges = { ...onDisk.ranges, ...patch }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }
    return { ok: true, changed: Object.keys(patch), ranges: rangesView(), persisted }
  })

  // ---- Tank ----
  app.get('/api/tank/latest', async () => {
    const params = {}
    for (const key of Object.keys(config.apex.inputs)) {
      const value = state.tank.latest[key]
      const range = config.ranges?.[key]
      let status = 'unknown'
      if (value != null && range) {
        status = value < range[0] ? 'low' : value > range[1] ? 'high' : 'ok'
      }
      params[key] = {
        value: value ?? null,
        status,
        range: range ?? null,
        ...PARAM_META[key]
      }
    }
    return { params, name: config.tankName ?? 'Reef Tank', updatedAt: state.tank.updatedAt, error: state.tank.error, feedUntil: state.tank.feedUntil ?? null }
  })

  app.get('/api/tank/history', async (req) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 24 * 90)
    const param = req.query.param
    const cutoff = Date.now() - hours * 3600 * 1000
    const rows = param
      ? db.prepare('SELECT ts, param, value FROM tank_readings WHERE param = ? AND ts >= ? ORDER BY ts').all(param, cutoff)
      : db.prepare('SELECT ts, param, value FROM tank_readings WHERE ts >= ? ORDER BY ts').all(cutoff)
    return { readings: rows }
  })

  // Raw list of every input the Apex reports — used once during setup to
  // map input names into config.json.
  app.get('/api/tank/inputs', async () => ({
    inputs: state.tank.inputs,
    updatedAt: state.tank.updatedAt,
    error: state.tank.error
  }))

  // ---- Environment (CO2 sensor daemon posts here) ----
  app.post('/api/environment', async (req, reply) => {
    const { co2_ppm, temp_c, humidity_pct } = req.body ?? {}
    if (co2_ppm == null && temp_c == null && humidity_pct == null) {
      return reply.code(400).send({ error: 'empty reading' })
    }
    const ts = Date.now()
    db.prepare('INSERT INTO env_readings (ts, co2_ppm, temp_c, humidity_pct) VALUES (?, ?, ?, ?)')
      .run(ts, co2_ppm ?? null, temp_c ?? null, humidity_pct ?? null)
    state.environment = { ts, co2_ppm, temp_c, humidity_pct }
    return { ok: true }
  })

  app.get('/api/environment/latest', async () => {
    const env = state.environment
      ?? db.prepare('SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings ORDER BY ts DESC LIMIT 1').get()
      ?? null
    let co2Status = 'unknown'
    if (env?.co2_ppm != null) {
      const { co2WarnPpm = 1000, co2HighPpm = 1500 } = config.environment ?? {}
      co2Status = env.co2_ppm >= co2HighPpm ? 'high' : env.co2_ppm >= co2WarnPpm ? 'warn' : 'ok'
    }
    return { ...env, co2Status }
  })

  app.get('/api/environment/history', async (req) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 24 * 90)
    const cutoff = Date.now() - hours * 3600 * 1000
    return {
      readings: db.prepare('SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings WHERE ts >= ? ORDER BY ts').all(cutoff)
    }
  })

  // ---- Room-temperature calibration ----
  // The SCD41 reads high: it lives in a warm enclosure beside the display, and
  // its humidity is derived from that same temperature, so an uncorrected
  // sensor also reports the room drier than it is. The chip's own offset is
  // the fix; the daemon re-reads this every cycle, so a change lands within a
  // minute without restarting anything. 4 C is the sensor's factory default.
  const DEFAULT_TEMP_OFFSET_C = 4

  app.get('/api/environment/config', async () => ({
    tempOffsetC: config.environment?.tempOffsetC ?? DEFAULT_TEMP_OFFSET_C
  }))

  // Tell the terminal what the room actually is and it works out the rest:
  // new offset = current + (what the sensor says - what the room is).
  app.post('/api/environment/calibrate', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'calibration is only available on the terminal itself' })
    }
    const { referenceC, referenceF } = req.body ?? {}
    const reference = referenceC != null
      ? Number(referenceC)
      : referenceF != null ? (Number(referenceF) - 32) * 5 / 9 : null
    if (reference == null || !Number.isFinite(reference) || reference < 0 || reference > 45) {
      return reply.code(400).send({ error: 'give the room temperature as referenceC (0-45) or referenceF' })
    }

    const measured = state.environment?.temp_c
    if (measured == null) {
      return reply.code(409).send({ error: 'no sensor reading yet - wait for the first one' })
    }

    const current = config.environment?.tempOffsetC ?? DEFAULT_TEMP_OFFSET_C
    const next = Math.round((current + (measured - reference)) * 100) / 100
    if (next < 0 || next > 20) {
      return reply.code(400).send({
        error: `that would need a ${next.toFixed(1)} C offset - check the temperature you gave`
      })
    }

    config.environment = { ...config.environment, tempOffsetC: next }
    // Keep it across reboots. A unit still on the example config has no
    // config.json to write into; the value stands until setup writes one.
    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.environment = { ...onDisk.environment, tempOffsetC: next }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }
    return {
      ok: true,
      tempOffsetC: next,
      previousOffsetC: current,
      measuredC: measured,
      referenceC: Math.round(reference * 100) / 100,
      persisted
    }
  })

  // ---- Photos (family slideshow) ----
  app.get('/api/photos', async () => ({
    photos: fs.readdirSync(photosDir)
      .filter((f) => PHOTO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort()
      .map((name) => ({ name, url: `/photos/${encodeURIComponent(name)}` }))
  }))

  app.post('/api/photos', async (req, reply) => {
    const uploaded = []
    const skipped = []
    for await (const part of req.files()) {
      const filename = part.filename ?? 'photo'
      const ext = path.extname(filename).toLowerCase()
      if (!PHOTO_EXTENSIONS.has(ext) && !CONVERTED_EXTENSIONS.has(ext)) {
        part.file.resume()
        skipped.push({ name: filename, reason: 'not a photo' })
        continue
      }

      let raw
      try {
        raw = await part.toBuffer()
      } catch (err) {
        // @fastify/multipart aborts the stream once a file passes the size limit.
        skipped.push({ name: filename, reason: /too large|limit/i.test(String(err.message)) ? 'bigger than 25 MB' : 'could not be read' })
        continue
      }

      let processed
      try {
        processed = await processPhoto(raw, ext)
      } catch (err) {
        skipped.push({ name: filename, reason: err.message })
        continue
      }

      const base = path.basename(filename, ext).replace(/[^\w-]+/g, '_').slice(0, 60)
      const name = `${Date.now()}-${base}${processed.ext}`
      await fs.promises.writeFile(path.join(photosDir, name), processed.buffer)
      uploaded.push(name)
    }
    if (!uploaded.length) {
      return reply.code(400).send({ error: skipped[0]?.reason ?? 'no image files received', uploaded, skipped })
    }
    return { uploaded, skipped }
  })

  // What the screen shows when nobody has touched it for a few minutes.
  //
  // Family photos were the only answer when this was a family display. On a
  // reef terminal the coral journal is the better one: those photos are of the
  // thing the screen is bolted next to, and they arrive dated and named, so an
  // idle screen can say what it is showing and when it was taken.
  const coralPhotoDir = path.join(path.dirname(config.db), 'corals')

  // How long the screen waits without a touch before the screensaver starts.
  // 0 means it never does. Five minutes is the default: long enough that a
  // glance at a parameter does not end with the logo swimming in, short
  // enough that the wall is not the dashboard all evening.
  const IDLE_CHOICES = [2, 5, 10, 30, 60, 0]
  const idleMinutesOf = () => {
    const m = Number(config.slideshow?.idleMinutes)
    return IDLE_CHOICES.includes(m) ? m : 5
  }

  function slideshowImages() {
    const source = config.slideshow?.source ?? 'intro'
    const images = []

    if (source === 'photos' || source === 'both') {
      for (const name of fs.readdirSync(photosDir).filter((f) => PHOTO_EXTENSIONS.has(path.extname(f).toLowerCase()))) {
        images.push({ id: `p:${name}`, url: `/photos/${encodeURIComponent(name)}`, caption: null })
      }
    }

    if (source === 'corals' || source === 'both') {
      const rows = db
        .prepare(
          `SELECT c.name AS name, p.ts AS ts, p.file AS file
           FROM coral_photos p JOIN corals c ON c.id = p.coral_id
           ORDER BY p.ts DESC`
        )
        .all()
      for (const row of rows) {
        // The file may have been removed by hand; a slideshow that shows a
        // broken image is worse than one that shows fewer.
        if (!fs.existsSync(path.join(coralPhotoDir, row.file))) continue
        images.push({
          id: `c:${row.file}`,
          url: `/coral-photos/${encodeURIComponent(row.file)}`,
          caption: `${row.name} · ${new Date(row.ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
        })
      }
    }
    return { source, images, idleMinutes: idleMinutesOf() }
  }

  app.get('/api/slideshow', async () => slideshowImages())

  app.get('/api/slideshow/config', async () => {
    const counts = { photos: 0, corals: 0 }
    try {
      counts.photos = fs.readdirSync(photosDir).filter((f) => PHOTO_EXTENSIONS.has(path.extname(f).toLowerCase())).length
    } catch { /* no photo dir yet */ }
    counts.corals = db.prepare('SELECT COUNT(*) AS n FROM coral_photos').get().n
    return { source: config.slideshow?.source ?? 'intro', idleMinutes: idleMinutesOf(), counts }
  })

  // Either field on its own or both together; whatever is sent is checked,
  // whatever is not stays as it was.
  app.post('/api/slideshow/config', async (req, reply) => {
    const patch = {}
    if (req.body?.source !== undefined) {
      const source = String(req.body.source)
      // 'intro' is the boot animation on a loop - needs no pictures, so it is
      // the default a fresh unit ships with.
      if (!['intro', 'photos', 'corals', 'both', 'off'].includes(source)) {
        return reply.code(400).send({ error: 'unknown slideshow source' })
      }
      patch.source = source
    }
    if (req.body?.idleMinutes !== undefined) {
      const m = Number(req.body.idleMinutes)
      if (!IDLE_CHOICES.includes(m)) return reply.code(400).send({ error: 'idleMinutes must be one of 2, 5, 10, 30, 60 or 0' })
      patch.idleMinutes = m
    }
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'nothing to change' })
    config.slideshow = { ...config.slideshow, ...patch }

    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.slideshow = { ...onDisk.slideshow, ...patch }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }
    return { ok: true, source: config.slideshow.source ?? 'intro', idleMinutes: idleMinutesOf(), persisted }
  })

  app.delete('/api/photos/:name', async (req, reply) => {
    const name = path.basename(req.params.name)
    const file = path.join(photosDir, name)
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' })
    fs.unlinkSync(file)
    return { ok: true }
  })

  // ---- Weather ----
  app.get('/api/weather', async () => ({
    ...(state.weather ?? { current: null, daily: [] }),
    radarUrl: radarUrl(config.weather ?? {})
  }))

  // ---- Ring doorbell ----
  const DING_ACTIVE_MS = 45000
  app.get('/api/ring/status', async () => {
    const { lastDing, snapshotAt } = state.ring
    return {
      ...state.ring,
      active: lastDing != null && Date.now() - lastDing < DING_ACTIVE_MS,
      hasSnapshot: (getRingSnapshot() != null || !!process.env.DEMO) && snapshotAt != null && snapshotAt >= (lastDing ?? 0)
    }
  })

  app.get('/api/ring/snapshot.jpg', async (req, reply) => {
    let snap = getRingSnapshot()
    if (!snap && process.env.DEMO) {
      // Demo stand-in: first uploaded photo doubles as the "camera" image
      const demo = fs.readdirSync(photosDir).find((f) => PHOTO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      if (demo) snap = fs.readFileSync(path.join(photosDir, demo))
    }
    if (!snap) return reply.code(404).send({ error: 'no snapshot' })
    return reply.type('image/jpeg').send(snap)
  })

  // Simulates a doorbell press (used by demo mode and for testing the overlay
  // from any phone: curl -X POST http://<pi>:8080/api/ring/test-ding)
  app.post('/api/ring/test-ding', async () => {
    state.ring.camera = state.ring.camera ?? 'Front Door'
    state.ring.lastDing = Date.now()
    if (process.env.DEMO) state.ring.snapshotAt = Date.now()
    return { ok: true }
  })

  // ---- Alerts ----
  app.post('/api/alerts/test', async (req, reply) => {
    try {
      await sendNtfy(config, {
        title: 'ReefGauge',
        message: 'Test alert — notifications are working! 🐠',
        priority: 'default',
        tags: 'tada'
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: String(err.message ?? err) })
    }
  })

  // ---- Red Sea equipment (ReefBeat devices on the LAN) ----
  app.get('/api/redsea/status', async () => ({
    devices: state.redsea?.devices ?? [],
    hidden: state.redsea?.hidden ?? [],
    alerts: (state.redsea?.devices ?? []).flatMap((d) =>
      (d.alerts ?? []).map((a) => ({ ...a, device: d.name }))
    ),
    discovering: state.redsea?.discovering ?? false,
    updatedAt: state.redsea?.updatedAt ?? null
  }))

  // What is wrong right now, for the display. Separate from /api/health, which
  // is for diagnosing a unit; this is what the family sees on the screen.
  app.get('/api/alerts', async () => {
    const alarm = state.alarmState?.() ?? { bypassUntil: null, silenced: [] }
    const quieted = new Set(alarm.silenced.map((s) => s.key))
    return {
      enabled: state.alerts?.enabled ?? false,   // whether pushes also go to phones
      bypassUntil: alarm.bypassUntil,
      sounding: alarm.sounding ?? [],
      active: (state.alerts?.active ?? []).map((a) => ({
        ...a,
        // The display needs to know which alerts a person has already dealt
        // with, so it can stay quiet about those and still show them.
        silenced: quieted.has(a.key) || alarm.bypassUntil != null,
        silenceMode: alarm.silenced.find((s) => s.key === a.key)?.mode ?? null,
        // Unacknowledged alerts are the display's business first: they get
        // the card, they keep the screensaver away, and they stay out of the
        // ticker until someone has tapped them.
        acknowledged: a.acknowledgedAt != null
      }))
    }
  })

  // ---- Alarm sounds ----
  // Which sound an alarm makes is a room decision, not an engineering one: a
  // nursery and a garage want opposite ends of this list.
  app.get('/api/alerts/sounds', async () => {
    const current = alarmConfig(config)
    return {
      sounds: Object.entries(SOUNDS).map(([id, s]) => ({ id, label: s.label, note: s.note })),
      urgentTone: current.urgentTone,
      warningTone: current.warningTone,
      enabled: current.enabled,
      quietFrom: current.quietFrom,
      quietTo: current.quietTo,
      loopMinutes: current.loopMinutes
    }
  })

  // Auditioning is terminal-only: it makes a noise in someone's house, and
  // possession of the API token is not the same as standing in the room.
  app.post('/api/alerts/sounds/test', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'sound tests run on the terminal' })
    }
    const name = String(req.body?.name ?? '')
    if (!SOUNDS[name]) return reply.code(400).send({ error: `unknown sound: ${name}` })
    return { ok: playTone(config, name), name }
  })

  app.post('/api/alerts/sounds', async (req, reply) => {
    const { urgentTone, warningTone, enabled, quietFrom, quietTo, loopMinutes } = req.body ?? {}
    for (const name of [urgentTone, warningTone]) {
      if (name != null && !SOUNDS[name]) {
        return reply.code(400).send({ error: `unknown sound: ${name}` })
      }
    }
    const hour = (v) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : null)
    if ((quietFrom != null && hour(quietFrom) == null) || (quietTo != null && hour(quietTo) == null)) {
      return reply.code(400).send({ error: 'quiet hours are whole hours, 0-23' })
    }
    const sound = { ...(config.alerts?.sound ?? {}) }
    if (urgentTone) sound.urgentTone = urgentTone
    if (warningTone) sound.warningTone = warningTone
    if (enabled != null) sound.enabled = !!enabled
    if (quietFrom != null) sound.quietFrom = quietFrom
    if (quietTo != null) sound.quietTo = quietTo
    // Bounded: an alarm that repeats for an hour gets the speaker unplugged,
    // and one that repeats once is not an alarm.
    if (loopMinutes != null) sound.loopMinutes = Math.max(1, Math.min(30, Number(loopMinutes) || 10))
    config.alerts = { ...config.alerts, sound }

    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.alerts = { ...onDisk.alerts, sound: { ...onDisk.alerts?.sound, ...sound } }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }
    const current = alarmConfig(config)
    return {
      ok: true,
      urgentTone: current.urgentTone,
      warningTone: current.warningTone,
      enabled: current.enabled,
      quietFrom: current.quietFrom,
      quietTo: current.quietTo,
      loopMinutes: current.loopMinutes,
      persisted
    }
  })

  // "Got it." The one tap that dismisses the alert card: the sound stops for
  // this occurrence and the alert moves to the ticker. It is not a silence -
  // the next time the same thing goes wrong, it shouts again.
  app.post('/api/alerts/ack', async (req, reply) => {
    const key = req.body?.key
    if (!key) return reply.code(400).send({ error: 'key required' })
    const at = state.acknowledgeAlert?.(key)
    if (at == null) return reply.code(404).send({ error: 'no such active alert' })
    return { ok: true, key, acknowledgedAt: at }
  })

  // Two ways to stop an alarm, meaning two different things.
  //
  // Silence covers the alerts that are up now and expires: the problem stays
  // on screen, and something new still breaks through.
  app.post('/api/alerts/silence', async (req) => {
    // A standing silence has no clock: it lasts until the condition has been
    // gone for a full day, which is a different promise from "24 hours".
    if (req.body?.mode === 'standing') {
      const keys = state.silenceStanding?.(req.body?.key)
      return { ok: true, mode: 'standing', silenced: req.body?.key ?? 'all', keys }
    }
    const minutes = Math.min(1440, Math.max(1, Number(req.body?.minutes) || 120))
    const until = state.silenceAlert?.(req.body?.key, minutes)
    return { ok: true, mode: 'timed', silenced: req.body?.key ?? 'all', minutes, until }
  })

  // Put every silenced alarm back on duty. The display offers this wherever it
  // shows that alarms are off, because a silence nobody can find is a silence
  // nobody can undo.
  app.post('/api/alerts/resume', async (req) => {
    state.resumeAlarms?.(req.body?.key)
    return { ok: true, resumed: req.body?.key ?? 'all' }
  })

  // Bypass covers everything for a while, including alerts that have not
  // happened yet — for someone working on the tank who expects readings to go
  // out of range. It always expires; there is no way to leave it on.
  app.post('/api/alerts/bypass', async (req) => {
    const minutes = Math.min(720, Math.max(1, Number(req.body?.minutes) || 360))
    const until = state.bypassAlarms?.(minutes)
    return { ok: true, minutes, until }
  })

  app.get('/api/health', async () => ({
    ok: true,
    apex: state.tank.error ?? 'ok',
    lastTankUpdate: state.tank.updatedAt,
    lastEnvReading: state.environment?.ts ?? null,
    alertsEnabled: state.alerts?.enabled ?? false,
    activeAlerts: state.alerts?.active ?? []
  }))
}
