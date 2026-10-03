import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
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
  // What the kiosk's browser can actually draw, reported by the dashboard when it
  // loads. A support operator cannot open chrome://gpu on a sealed unit, and the
  // first visible symptom of a GPU problem was the weather radar failing while
  // everything else drew fine. Kept in memory; the body is bounded.
  app.post('/api/display/capabilities', async (req) => {
    const b = req.body ?? {}
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)
    state.display = {
      webgl: b.webgl === 'webgl2' || b.webgl === 'webgl' ? b.webgl : false,
      renderer: str(b.renderer, 120),
      vendor: str(b.vendor, 80),
      userAgent: str(b.userAgent, 200),
      viewport: str(b.viewport, 20),
      reportedAt: Date.now()
    }
    return { ok: true }
  })

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
    for (const [key, inputName] of Object.entries(config.apex.inputs)) {
      // A null mapping is someone having said "nothing measures this" on the
      // probe screen. Keys were once only ever present when mapped, so a
      // truthiness check was not needed here; now it is, and without it saying
      // "nothing measures this" produced a permanently empty gauge instead of
      // removing it - exactly the opposite of what was asked for.
      if (!inputName) continue
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
        // Where the number came from, when it is not the Apex's own probe. A
        // KH monitor's reading arrives down a pH input, and the screen should
        // say so rather than implying the Apex measured it - the customer
        // bought the other box, and when they ring up about a reading it
        // matters which device is being talked about.
        source: config.apex?.inputSources?.[key] ?? null,
        ...PARAM_META[key]
      }
    }
    // Whether a controller is configured at all - a different question from
    // whether a reading has arrived yet. Without it the home screen said
    // "Waiting for Apex..." to a customer who skipped the Apex step, or who
    // does not own one: waiting, in perpetuity, for something never coming.
    return {
      params,
      apexConfigured: Boolean(config.apex?.host),
      name: config.tankName ?? 'Reef Tank',
      updatedAt: state.tank.updatedAt,
      error: state.tank.error,
      feedUntil: state.tank.feedUntil ?? null
    }
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

  // ---- Puck firmware, held for the puck to come and fetch ----
  //
  // The puck has no inbound server, deliberately, so the terminal cannot push
  // an update to it. It holds the image and mentions it in the reply to a
  // reading; the puck decides, fetches and applies. See firmware/puck/ota.h.
  //
  // Images live in firmware/dist/, one per chip, beside a manifest naming the
  // version, size and SHA-256 of each. The digest is the whole of the integrity
  // story on the puck's side, so it is read from the manifest and never
  // recomputed here - if the two ever disagree, the puck refuses the image,
  // which is the correct outcome.
  const firmwareDir = path.resolve(config.serverRoot, '../firmware/dist')

  function puckFirmware(chip) {
    if (!chip || !/^[a-z0-9]+$/.test(chip)) return null
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(firmwareDir, 'puck.json'), 'utf8'))
      const entry = manifest[chip]
      if (!entry?.version || !entry?.sha256 || !entry?.file) return null
      const file = path.join(firmwareDir, path.basename(entry.file))
      if (!fs.existsSync(file)) return null
      return { ...entry, file }
    } catch {
      return null   // no firmware staged on this unit; that is normal
    }
  }

  app.get('/api/puck/firmware', async (req, reply) => {
    const fw = puckFirmware(req.query?.chip)
    if (!fw) return reply.code(404).send({ error: 'no puck firmware for that chip' })
    return reply.type('application/octet-stream').send(fs.createReadStream(fw.file))
  })

  // ---- Which Apex input is which reading ----
  //
  // Setup maps these automatically, by the Apex's own input type first and a
  // name pattern second, and for a Trident that is right every time. It is not
  // right for everything else plugged into an Apex, and when it is wrong it is
  // wrong silently: the value is a plausible number in a plausible place.
  //
  // The case that forced this is a KH monitor - AquaWiz, Ekoral - whose BNC
  // output is a pH-electrode signal carrying the alkalinity figure. The Apex
  // reports it with type "pH", so unless the customer happened to name it
  // something beginning with "alk", it is adopted as the tank's pH and the wall
  // shows 8.2 pH that is really 8.2 dKH. Nothing about that looks wrong.
  //
  // So: let someone say what a thing actually is.
  const MAPPABLE = ['temp', 'ph', 'salinity', 'alk', 'ca', 'mg', 'no3', 'po4']

  // A KH monitor on a pH input is not a quirk to be tolerated - it is a
  // supported way to wire one up, and worth recording as such. It changes
  // nothing about how the value is read; it means the terminal can say where
  // the number came from instead of implying the Apex measured it.
  const SIGNAL_SOURCES = ['apex', 'aquawiz', 'ekoral']

  app.get('/api/apex/inputs', async () => ({
    configured: !!config.apex?.host,
    inputs: state.tank?.inputs ?? [],
    mapping: config.apex?.inputs ?? {},
    sources: config.apex?.inputSources ?? {},
    params: MAPPABLE,
    updatedAt: state.tank?.updatedAt ?? null,
    error: state.tank?.error ?? null
  }))

  app.post('/api/apex/inputs', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'probe mapping is only available on the terminal itself' })
    }
    const { param, inputName, source } = req.body ?? {}
    if (!MAPPABLE.includes(param)) {
      return reply.code(400).send({ error: `param must be one of ${MAPPABLE.join(', ')}` })
    }
    if (source != null && !SIGNAL_SOURCES.includes(source)) {
      return reply.code(400).send({ error: `source must be one of ${SIGNAL_SOURCES.join(', ')}` })
    }

    // null clears it. Stored as an explicit null rather than deleted, because
    // "there is no probe for this" and "nobody has said yet" are different
    // things - and the poller's auto-adopt is allowed to fill only the second.
    let next = null
    if (inputName != null) {
      const known = (state.tank?.inputs ?? []).some((i) => i.name === inputName)
      if (!known) {
        return reply.code(400).send({ error: `the Apex is not reporting an input called "${inputName}"` })
      }
      next = inputName
    }

    const mapping = { ...(config.apex?.inputs ?? {}), [param]: next }
    const sources = { ...(config.apex?.inputSources ?? {}) }
    if (next == null || source == null || source === 'apex') delete sources[param]
    else sources[param] = source

    config.apex = { ...config.apex, inputs: mapping, inputSources: sources }

    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.apex = { ...onDisk.apex, inputs: mapping, inputSources: sources }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }

    app.log.warn({ param, inputName: next, source: sources[param] ?? 'apex' }, 'probe mapping changed')
    // No restart: the poller re-reads config.apex every cycle, so this lands on
    // the next one - within a minute, by default.
    return { ok: true, param, inputName: next, source: sources[param] ?? null, mapping, sources, persisted }
  })

  // ---- Environment (CO2 sensor daemon posts here) ----
  // Two things report here now: the sensor behind the screen, and a puck in
  // the cabinet. They measure different air - the cabinet is what the skimmer
  // draws and therefore what sets the tank's pH ceiling - so a reading that
  // does not say where it came from is worth very little.
  //
  // 'display' is the default because that is what every existing caller is:
  // the terminal's own co2_daemon.py has never sent a location and should not
  // have to start.
  const LOCATIONS = new Set(['display', 'cabinet'])

  app.post('/api/environment', async (req, reply) => {
    const { co2_ppm, temp_c, humidity_pct, source, frcAck, chip, fw } = req.body ?? {}
    if (co2_ppm == null && temp_c == null && humidity_pct == null) {
      return reply.code(400).send({ error: 'empty reading' })
    }
    const location = LOCATIONS.has(req.body?.location) ? req.body.location : 'display'

    const ts = Date.now()
    db.prepare('INSERT INTO env_readings (ts, co2_ppm, temp_c, humidity_pct, location) VALUES (?, ?, ?, ?, ?)')
      .run(ts, co2_ppm ?? null, temp_c ?? null, humidity_pct ?? null, location)

    const reading = { ts, co2_ppm, temp_c, humidity_pct, source: source ?? null }
    state.env = { ...(state.env ?? {}), [location]: reading }
    // state.environment stays the display sensor, unchanged. The alert engine,
    // the diagnostics and the room-air card all read it, and quietly making it
    // mean "whichever sensor reported last" would have the cabinet's air
    // driving alarms written for the room.
    if (location === 'display') state.environment = reading

    // "I did the recalibration you asked for", riding along with the first
    // reading taken afterwards. The puck cannot call /frc/ack itself - it POSTs
    // and nothing more - and without this the request stays outstanding and is
    // handed back on every subsequent reply, writing the sensor's EEPROM again
    // and again.
    if (frcAck?.id) {
      const outstanding = pendingFrc[location]
      if (outstanding && outstanding.id === frcAck.id) {
        delete pendingFrc[location]
        state.frcResult = {
          ...(state.frcResult ?? {}),
          [location]: {
            at: Date.now(),
            ok: frcAck.ok !== false,
            referencePpm: outstanding.ppm,
            correctionPpm: Number.isFinite(Number(frcAck.correctionPpm)) ? Number(frcAck.correctionPpm) : null,
            error: frcAck.error ?? null
          }
        }
        app.log.warn({ location, ok: frcAck.ok !== false, frcAck }, 'CO2 forced recalibration finished')
      }
    }

    // A sensor with no inbound server can still be configured, as long as the
    // answer to "here is my reading" carries what it should be doing. The puck
    // has nothing listening on it by design; this is the whole channel.
    return {
      ok: true,
      location,
      config: {
        tempOffsetC: currentOffset(location),
        frc: frcRequestFor(location),
        // Offered only when it is a different build from the one reporting.
        // "Different", not "newer": the version is a git sha with no ordering,
        // and different-from-what-is-running is the question that matters -
        // which also makes a deliberate downgrade work with no special case.
        ...(() => {
          const available = puckFirmware(chip)
          if (!available || !fw || available.version === fw) return {}
          return { update: {
            version: available.version,
            sha256: available.sha256,
            size: available.size ?? null
          } }
        })()
      }
    }
  })

  app.get('/api/environment', async () => ({
    display: state.env?.display ?? state.environment ?? null,
    cabinet: state.env?.cabinet ?? null
  }))

  const latestFor = (location) => state.env?.[location]
    ?? db.prepare('SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings WHERE location = ? ORDER BY ts DESC LIMIT 1').get(location)
    ?? null

  app.get('/api/environment/latest', async () => {
    // state.environment is still the display sensor and still the fallback for
    // a unit whose rows all predate the location column.
    const env = state.environment ?? latestFor('display')
      ?? db.prepare('SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings ORDER BY ts DESC LIMIT 1').get()
      ?? null
    const { co2WarnPpm = 1000, co2HighPpm = 1500 } = config.environment ?? {}
    const grade = (ppm) => ppm == null ? 'unknown'
      : ppm >= co2HighPpm ? 'high' : ppm >= co2WarnPpm ? 'warn' : 'ok'

    const cabinet = latestFor('cabinet')
    return {
      ...env,
      co2Status: grade(env?.co2_ppm),
      // The cabinet is only present once a puck has ever reported. A terminal
      // without one should show no trace of it rather than an empty slot for
      // something the customer has not bought.
      cabinet: cabinet ? { ...cabinet, co2Status: grade(cabinet.co2_ppm) } : null
    }
  })

  app.get('/api/environment/history', async (req) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 24 * 90)
    const cutoff = Date.now() - hours * 3600 * 1000
    // By location, and 'display' by default.
    //
    // This had no location filter, and once the puck started reporting it
    // returned both sensors interleaved, ordered by time - so the 24-hour CO2
    // line on the home card was drawing the room and the cabinet as one series,
    // zigzagging between them every thirty seconds. It looked like violent
    // swings in a room that was actually steady.
    //
    // 'display' is the default because that is what every existing caller
    // wants, and what the endpoint used to return before a second sensor
    // existed at all. Rows written before the location column are display rows,
    // so they are included.
    const location = LOCATIONS.has(req.query?.location) ? req.query.location : 'display'
    const readings = location === 'display'
      ? db.prepare(`SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings
                    WHERE ts >= ? AND (location = 'display' OR location IS NULL)
                    ORDER BY ts`).all(cutoff)
      : db.prepare(`SELECT ts, co2_ppm, temp_c, humidity_pct FROM env_readings
                    WHERE ts >= ? AND location = ? ORDER BY ts`).all(cutoff, location)
    return { location, readings }
  })

  // ---- Room-temperature calibration ----
  // The SCD41 reads high: it lives in a warm enclosure beside the display, and
  // its humidity is derived from that same temperature, so an uncorrected
  // sensor also reports the room drier than it is. The chip's own offset is
  // the fix; the daemon re-reads this every cycle, so a change lands within a
  // minute without restarting anything. 4 C is the sensor's factory default.
  const DEFAULT_TEMP_OFFSET_C = 4

  // The puck needs its own. It is the same chip, but self-heating is a property
  // of the enclosure, not the sensor: the display's board sits in a sealed case
  // beside a Pi and a backlight, the puck's in a cabinet with a return pump.
  // One offset for both is how the same house came to read 31 C and 19 C.
  const DEFAULT_CABINET_OFFSET_C = 6

  const OFFSET_KEY = { display: 'tempOffsetC', cabinet: 'cabinetTempOffsetC' }
  const OFFSET_DEFAULT = { display: DEFAULT_TEMP_OFFSET_C, cabinet: DEFAULT_CABINET_OFFSET_C }
  const MAX_OFFSET_C = 20

  function currentOffset(location) {
    const value = config.environment?.[OFFSET_KEY[location]]
    return Number.isFinite(value) ? value : OFFSET_DEFAULT[location]
  }

  // A forced recalibration in flight, per sensor: { ppm, id, requestedAt }.
  //
  // Deliberately not persisted. It is an instruction to a sensor sitting in air
  // of a known concentration right now - if the terminal reboots before it is
  // carried out, the moment has passed and firing it days later would calibrate
  // against whatever air happened to be there.
  const pendingFrc = {}

  function frcRequestFor(location) {
    const req = pendingFrc[location]
    return req ? { ppm: req.ppm, id: req.id } : null
  }

  app.get('/api/environment/config', async () => ({
    // Unchanged for the display daemon, which has always read just this.
    tempOffsetC: currentOffset('display'),
    cabinetTempOffsetC: currentOffset('cabinet'),
    frc: frcRequestFor('display')
  }))

  // Tell the terminal what the room actually is and it works out the rest:
  // new offset = current + (what the sensor says - what the room is).
  //
  // `location` is 'display', 'cabinet', or 'all' - and 'all' is not a
  // convenience. Two sensors sitting in the same air are measuring one
  // temperature, so one thermometer reading is the correct reference for both,
  // and calibrating them separately from the same number is the same operation
  // done twice. It is only wrong once the puck is in the cabinet, which is
  // warmer than the room it is in.
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

    const asked = req.body?.location ?? 'display'
    const targets = asked === 'all'
      ? ['display', 'cabinet']
      : LOCATIONS.has(asked) ? [asked] : null
    if (!targets) {
      return reply.code(400).send({ error: "location must be 'display', 'cabinet' or 'all'" })
    }

    // Work out every change and check every one of them before writing any.
    // A half-applied calibration leaves two sensors disagreeing differently
    // than they did before, which is harder to reason about than not having
    // started.
    // What the sensor is reading, from several samples rather than whichever one
    // happened to be latest.
    //
    // This took a single instantaneous value, and a single value is exactly
    // what should not be trusted here. The reading spikes - a sensor that sat
    // at 72 F produced 77.5 and 79.1 within the same minute - and a calibration
    // catching one writes that spike into a persistent offset, so a sensor that
    // was correct ends up several degrees wrong until somebody notices. It also
    // compounds: the offset is applied to the chip, which restarts measurement,
    // and the next few readings are in flux - so calibrating twice in quick
    // succession multiplies the error rather than correcting it. Watched all of
    // that happen on the bench.
    //
    // The median of a short window is immune to a lone spike, and the spread
    // across that window says whether the sensor has settled at all.
    const SETTLE_WINDOW_MS = 10 * 60 * 1000
    const MIN_SAMPLES = 3
    const MAX_SPREAD_C = 1.5        // ~2.7 F; wider than drift, narrower than a spike

    function recentTemps(location) {
      const rows = db.prepare(
        `SELECT temp_c FROM env_readings
         WHERE ts >= ? AND temp_c IS NOT NULL
           AND (location = ? OR (? = 'display' AND location IS NULL))
         ORDER BY ts DESC LIMIT 20`
      ).all(Date.now() - SETTLE_WINDOW_MS, location, location)
      return rows.map((r) => r.temp_c)
    }

    const changes = []
    const skipped = []
    for (const location of targets) {
      // Judged entirely on the stored readings, not on what happens to be in
      // memory. The server keeps the latest reading in memory and loses it on
      // restart, so calibrating within a minute of an update refused with "it
      // has not reported a reading yet" - about a sensor that had been
      // reporting for hours, with ten minutes of it in the database. The window
      // below answers both questions at once: enough samples means the sensor
      // is alive, and their spread means it has settled.
      const temps = recentTemps(location)
      if (temps.length < MIN_SAMPLES) {
        skipped.push({ location,
          reason: temps.length === 0
            ? 'it has not reported in the last ten minutes - check it is powered and connected'
            : `only ${temps.length} reading(s) in the last ten minutes - wait for a few more, `
              + 'so this is not calibrated against a single sample' })
        continue
      }
      const spread = Math.max(...temps) - Math.min(...temps)
      if (spread > MAX_SPREAD_C) {
        skipped.push({ location,
          reason: `still settling - its readings have moved ${(spread * 9 / 5).toFixed(1)} F `
            + 'in the last ten minutes. Calibrating now would store that movement as a correction.' })
        continue
      }
      const sorted = [...temps].sort((a, b) => a - b)
      const measured = sorted[Math.floor(sorted.length / 2)]
      const current = currentOffset(location)
      const next = Math.round((current + (measured - reference)) * 100) / 100
      if (next < 0 || next > MAX_OFFSET_C) {
        // Naming the sensor matters here: with 'all', the number in the message
        // is useless if you cannot tell which sensor produced it.
        return reply.code(400).send({
          error: `the ${location} sensor would need a ${next.toFixed(1)} C offset `
            + `(it reads ${measured.toFixed(1)} C) - check the temperature you gave`
        })
      }
      changes.push({ location, key: OFFSET_KEY[location], current, next, measured,
                     samples: temps.length, spreadC: Math.round(spread * 100) / 100 })
    }

    if (!changes.length) {
      return reply.code(409).send({
        error: targets.length > 1
          ? 'neither sensor has reported a reading yet - wait for the first one'
          : `the ${targets[0]} sensor has not reported a reading yet - wait for the first one`
      })
    }

    const applied = Object.fromEntries(changes.map((c) => [c.key, c.next]))
    config.environment = { ...config.environment, ...applied }
    // Keep it across reboots. A unit still on the example config has no
    // config.json to write into; the value stands until setup writes one.
    let persisted = false
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.environment = { ...onDisk.environment, ...applied }
      saveConfigAtomic(config.configPath, onDisk)
      persisted = true
    }

    return {
      ok: true,
      referenceC: Math.round(reference * 100) / 100,
      persisted,
      // Flat fields for the original single-sensor callers, which only ever
      // calibrated the display and only ever read tempOffsetC.
      ...(changes[0].location === 'display'
        ? { tempOffsetC: changes[0].next, previousOffsetC: changes[0].current, measuredC: changes[0].measured }
        : {}),
      sensors: changes.map(({ location, current, next, measured, samples, spreadC }) => ({
        location, offsetC: next, previousOffsetC: current, measuredC: measured,
        // What it was actually calibrated against, so an unexpected offset can
        // be explained rather than guessed at.
        samples, spreadC
      })),
      skipped
    }
  })

  // ---- CO2 forced recalibration ----
  //
  // The puck runs with automatic self-calibration off, and that is correct: ASC
  // works by assuming the sensor sees genuine fresh air every so often, which is
  // true of an office that empties overnight and false of a sealed cabinet with
  // a skimmer drawing from it. The consequence is that forced recalibration is
  // the *only* thing that corrects its CO2, so it has to be a feature rather
  // than a service procedure - a sensor with no correction path drifts until it
  // reads below outdoor air, which is how this one got to 330 ppm indoors.
  //
  // This does not calibrate anything by itself. It records that a sensor should
  // recalibrate against a known concentration; the sensor carries it out and
  // says so. The daemon collects it from /api/environment/config, the puck from
  // the reply to its own reading, because nothing listens on the puck.
  const FRESH_AIR_PPM = 425

  app.post('/api/environment/frc', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'calibration is only available on the terminal itself' })
    }
    const location = LOCATIONS.has(req.body?.location) ? req.body.location : 'display'
    const ppm = req.body?.ppm == null ? FRESH_AIR_PPM : Number(req.body.ppm)
    // Below ~350 is below anything on Earth outdoors, and a mistyped reference
    // is written into the sensor's own EEPROM - it outlives the mistake.
    if (!Number.isFinite(ppm) || ppm < 350 || ppm > 2000) {
      return reply.code(400).send({ error: 'ppm must be between 350 and 2000 (outdoor air is about 425)' })
    }
    const latest = location === 'cabinet' ? state.env?.cabinet : state.environment
    if (!latest) {
      return reply.code(409).send({ error: `the ${location} sensor has not reported a reading yet` })
    }

    pendingFrc[location] = { ppm, id: `${Date.now().toString(36)}`, requestedAt: Date.now() }
    app.log.warn({ location, ppm }, 'CO2 forced recalibration requested')
    return { ok: true, location, ppm, id: pendingFrc[location].id, measuredPpm: latest.co2_ppm ?? null }
  })

  // How it went, from whichever sensor carried it out. Acknowledging by id is
  // what keeps a request from being performed twice: neither collector clears
  // it on read, so a sensor that dies mid-recalibration has not silently
  // consumed the instruction.
  app.post('/api/environment/frc/ack', async (req, reply) => {
    const location = LOCATIONS.has(req.body?.location) ? req.body.location : 'display'
    const { id, ok, correctionPpm, error } = req.body ?? {}
    const outstanding = pendingFrc[location]
    if (!outstanding || outstanding.id !== id) {
      return reply.code(409).send({ error: 'no recalibration is outstanding with that id' })
    }
    delete pendingFrc[location]
    state.frcResult = {
      ...(state.frcResult ?? {}),
      [location]: {
        at: Date.now(),
        ok: ok !== false,
        referencePpm: outstanding.ppm,
        correctionPpm: Number.isFinite(Number(correctionPpm)) ? Number(correctionPpm) : null,
        error: error ?? null
      }
    }
    app.log.warn({ location, ok: ok !== false, correctionPpm, error }, 'CO2 forced recalibration finished')
    return { ok: true }
  })

  // What the calibration screen needs in one call: where each sensor is, what
  // it reads, what offset it is carrying, and whether it reads below outdoor
  // air - which is not a judgement call, it is impossible indoors.
  // A sensor that stopped reporting still has a last reading, and the screen
  // was showing it as though it were current - including the "below outdoor
  // air, this needs recalibrating" warning, about a sensor that had been
  // unplugged for two days. Same threshold as the offline alert, so the two
  // never disagree.
  const ENV_STALE_MS = 15 * 60 * 1000

  app.get('/api/environment/calibration', async () => {
    const describe = (location) => {
      const latest = location === 'cabinet' ? latestFor('cabinet') : (state.environment ?? latestFor('display'))
      return {
        location,
        present: latest != null,
        ts: latest?.ts ?? null,
        tempC: latest?.temp_c ?? null,
        co2Ppm: latest?.co2_ppm ?? null,
        humidityPct: latest?.humidity_pct ?? null,
        offsetC: currentOffset(location),
        defaultOffsetC: OFFSET_DEFAULT[location],
        ageMs: latest?.ts != null ? Date.now() - latest.ts : null,
        stale: latest?.ts == null || Date.now() - latest.ts > ENV_STALE_MS,
        // Only meaningful about a reading that is actually current. A sensor
        // that has been unplugged for two days is not reading low; it is not
        // reading at all, and telling someone to recalibrate it sends them to
        // the wrong problem.
        belowFreshAir: latest?.co2_ppm != null && latest.co2_ppm < FRESH_AIR_PPM
          && latest?.ts != null && Date.now() - latest.ts <= ENV_STALE_MS,
        pendingFrc: frcRequestFor(location),
        lastFrc: state.frcResult?.[location] ?? null
      }
    }
    const sensors = [describe('display'), describe('cabinet')].filter((s) => s.present)
    // Comparing a live reading with a two-day-old one and calling the
    // difference a disagreement is how you send someone to calibrate a sensor
    // that is merely unplugged.
    const live = sensors.filter((s) => !s.stale)
    const temps = live.map((s) => s.tempC).filter((t) => t != null)
    const co2s = live.map((s) => s.co2Ppm).filter((c) => c != null)
    return {
      freshAirPpm: FRESH_AIR_PPM,
      maxOffsetC: MAX_OFFSET_C,
      sensors,
      // Two sensors in one room are measuring one temperature and one air. How
      // far apart they are is the whole story, so the screen should not have to
      // work it out from the cards.
      tempSpreadC: temps.length > 1 ? Math.round((Math.max(...temps) - Math.min(...temps)) * 100) / 100 : null,
      co2SpreadPpm: co2s.length > 1 ? Math.max(...co2s) - Math.min(...co2s) : null
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
  // ---- phone alerts --------------------------------------------------------
  //
  // The tank tells the wall it is in trouble whether or not anyone is standing
  // in front of it. This is how it reaches a phone, and until now there was no
  // way to switch it on: the send path existed, the diagnostics reported it
  // missing, and nothing anywhere let a customer set it.
  //
  // ntfy.sh, because it needs no account on either end - the terminal POSTs to
  // a topic and every phone in the house subscribes to it. The whole cost of
  // that is that a topic is a bearer secret: anyone who knows the name can read
  // a family's alarms AND publish to them, which is the worse half - a stranger
  // able to invent a 3am alarm about someone's tank. So the topic is 120 random
  // bits generated here and never shown as something to type.

  const phoneState = () => {
    const topic = config.alerts?.ntfyTopic ?? null
    const server = (config.alerts?.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '')
    return { enabled: !!topic, subscribeUrl: topic ? `${server}/${topic}` : null }
  }

  app.get('/api/alerts/phone', async () => {
    const state = phoneState()
    if (!state.subscribeUrl) return state
    return { ...state, svg: await QRCode.toString(state.subscribeUrl, { type: 'svg', margin: 1 }) }
  })

  app.post('/api/alerts/phone', async (req, reply) => {
    // Regenerating is how you revoke: an old topic keeps working for whoever
    // still has it, so "my ex-flatmate still gets my tank alarms" has an answer
    // that does not involve support.
    const existing = config.alerts?.ntfyTopic
    if (existing && req.body?.regenerate !== true) {
      const state = phoneState()
      return { ...state, svg: await QRCode.toString(state.subscribeUrl, { type: 'svg', margin: 1 }) }
    }

    // base32-ish alphabet: no vowels, no look-alikes. Nobody should ever need
    // to read this out, but if they do it should not be ambiguous.
    const alphabet = '23456789bcdfghjkmnpqrstvwxyz'
    const bytes = crypto.randomBytes(24)
    let topic = 'reefgauge-'
    for (const b of bytes) topic += alphabet[b % alphabet.length]

    config.alerts = { ...config.alerts, ntfyTopic: topic }
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.alerts = { ...onDisk.alerts, ntfyTopic: topic }
      saveConfigAtomic(config.configPath, onDisk)
    }

    const state = phoneState()
    return { ...state, regenerated: !!existing,
             svg: await QRCode.toString(state.subscribeUrl, { type: 'svg', margin: 1 }) }
  })

  app.delete('/api/alerts/phone', async () => {
    config.alerts = { ...config.alerts, ntfyTopic: '' }
    if (!config.isExample && fs.existsSync(config.configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.alerts = { ...onDisk.alerts, ntfyTopic: '' }
      saveConfigAtomic(config.configPath, onDisk)
    }
    // Phones already subscribed simply stop hearing anything, because nothing
    // is published to that topic again.
    return phoneState()
  })

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
