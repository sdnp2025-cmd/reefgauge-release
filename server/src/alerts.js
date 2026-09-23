// Push alerts via ntfy.sh (free, no account): the server POSTs to a topic,
// every family phone subscribes to that topic in the ntfy app.
// Alerts fire when a condition starts, re-fire after the cooldown while it
// persists, and send a low-priority "recovered" note when it clears.

import fs from 'node:fs'
import path from 'node:path'

import { PARAM_META } from './config.js'
import { playAlarm, alarmConfig } from './alarmSound.js'

const CHECK_SECONDS = 60
const APEX_STALE_MS = 10 * 60 * 1000
const ENV_STALE_MS = 15 * 60 * 1000

export async function sendNtfy(config, { title, message, priority = 'default', tags = 'droplet' }) {
  const alerts = config.alerts ?? {}
  if (!alerts.ntfyTopic) throw new Error('alerts not configured (set alerts.ntfyTopic)')
  const server = (alerts.ntfyServer ?? 'https://ntfy.sh').replace(/\/$/, '')
  const res = await fetch(`${server}/${alerts.ntfyTopic}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: tags },
    body: message,
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`)
}

export function startAlerts(config, state, db) {
  // Detecting and notifying are two different jobs, and this used to conflate
  // them: with no ntfy topic set the whole engine returned here, so nothing was
  // ever *detected* either. A unit whose owner never set up push — which is
  // most of them, since it needs a phone app and a topic name — could lose its
  // Apex entirely and say nothing, anywhere. Detection now always runs and
  // feeds the display; ntfy is only how it additionally reaches a phone.
  const pushEnabled = !!config.alerts?.ntfyTopic
  state.alerts = { enabled: pushEnabled, active: [] }
  if (!pushEnabled) {
    console.log('Push alerts off (set alerts.ntfyTopic) — on-screen alarms still active')
  }

  const cooldownMs = (config.alerts?.cooldownMinutes ?? 120) * 60 * 1000
  const lastSent = new Map()

  // The panel has speakers, so an alarm can be heard by whoever is in the
  // room rather than only by whoever is holding a phone. Tracked per alert:
  // when it last sounded, how many times, and whether someone silenced it.
  // How far back inside a range a reading must come before its alert clears,
  // as a fraction of the range's width. 10% of a 77-79 band is 0.2 degrees.
  const hysteresis = Math.min(0.4, Math.max(0, (config.alerts?.hysteresisPercent ?? 10) / 100))

  const sound = alarmConfig(config)
  const sounding = new Map()     // key -> { startedAt, lastAt } while a loop runs

  // Silences are richer than a timestamp now. A timed one expires; a standing
  // one lasts until the condition has genuinely gone away and stayed away.
  //   { mode: 'timed', until }
  //   { mode: 'standing', clearedAt }   clearedAt null while still wrong
  const silenced = new Map()

  // Acknowledgement is a different thing from silence. A new alert is loud
  // and in the way on the display until a person taps it; acknowledging it
  // stops the sound for THIS occurrence and lets the display move it to the
  // ticker. It says nothing about the next time the same thing happens -
  // that is a new alert and it shouts again. Persisted with the silences so
  // a restart does not re-shout at someone who already dealt with it.
  const acknowledged = new Map()      // key -> { at }

  // A blanket bypass, for someone with their hands in the tank who expects
  // readings to go out of range for a while. Unlike a silence it also covers
  // alerts that have not happened yet, which is the whole point of it.
  let bypassUntil = 0

  // Silences outlive a restart. "Permanently" that forgets itself the next
  // time the server restarts — which happens on every config change and every
  // update — would be a promise the product does not keep.
  const silenceFile = db ? path.join(path.dirname(config.db), 'alert-silences.json') : null
  const loadSilences = () => {
    if (!silenceFile || !fs.existsSync(silenceFile)) return
    try {
      const saved = JSON.parse(fs.readFileSync(silenceFile, 'utf8'))
      for (const [key, entry] of Object.entries(saved.silenced ?? {})) silenced.set(key, entry)
      for (const [key, entry] of Object.entries(saved.acknowledged ?? {})) acknowledged.set(key, entry)
      bypassUntil = saved.bypassUntil ?? 0
    } catch (err) {
      console.warn(`could not read saved alarm silences: ${err.message}`)
    }
  }
  const saveSilences = () => {
    if (!silenceFile) return
    try {
      fs.writeFileSync(silenceFile, JSON.stringify({
        silenced: Object.fromEntries(silenced), acknowledged: Object.fromEntries(acknowledged), bypassUntil
      }))
    } catch (err) {
      console.warn(`could not save alarm silences: ${err.message}`)
    }
  }
  loadSilences()

  const STANDING_REARM_MS = 24 * 60 * 60 * 1000

  const isSilenced = (key) => {
    const now = Date.now()
    if (now < bypassUntil) return true
    const entry = silenced.get(key)
    if (!entry) return false

    if (entry.mode === 'standing') {
      // Still wrong, or wrong again recently: stay quiet.
      if (!entry.clearedAt) return true
      // The condition has to be gone for a full day before this alert earns
      // its voice back. Anything less and a reading flickering in and out
      // would defeat the whole point of silencing it.
      if (now - entry.clearedAt < STANDING_REARM_MS) return true
      silenced.delete(key)
      saveSilences()
      return false
    }

    if (now >= entry.until) { silenced.delete(key); saveSilences(); return false }
    return true
  }

  const audible = (priority) => priority === 'urgent' || priority === 'high'

  // Starting an alarm arms a loop rather than playing once. The loop below is
  // what actually makes noise.
  const soundFor = (key, priority) => {
    // An acknowledged occurrence stays quiet: raise() runs every check and
    // would otherwise re-arm the loop sixty seconds after the tap.
    if (!audible(priority) || isSilenced(key) || acknowledged.has(key)) return
    if (!sounding.has(key)) sounding.set(key, { startedAt: Date.now(), lastAt: 0, priority })
  }

  // An alarm repeats until somebody deals with it or the ten minutes run out.
  // A single beep is missed by anyone out of the room at that moment; a beep
  // that never stops gets the speaker unplugged. Ten minutes is long enough to
  // walk in from the garden and short enough not to become furniture.
  const loopMs = sound.loopMinutes * 60 * 1000
  const gapMs = sound.loopGapSeconds * 1000
  const alarmLoop = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of sounding) {
      const alert = state.alerts.active.find((a) => a.key === key)
      if (!alert || isSilenced(key)) { sounding.delete(key); continue }
      if (now - entry.startedAt > loopMs) {
        // Its ten minutes are spent. The entry stays so soundFor cannot arm it
        // all over again while the same alert is still active, but it is no
        // longer sounding and must stop saying that it is.
        entry.done = true
        continue
      }
      if (now - entry.lastAt < gapMs) continue
      if (playAlarm(config, entry.priority === 'urgent' ? 'urgent' : 'warning')) entry.lastAt = now
    }
  }, 1000)
  alarmLoop.unref?.()

  // Timed silence: the alerts on screen go quiet for a while and come back if
  // they are still wrong afterwards.
  state.silenceAlert = (key, minutes = 120) => {
    const until = Date.now() + minutes * 60 * 1000
    const keys = key ? [key] : state.alerts.active.map((a) => a.key)
    for (const k of keys) {
      silenced.set(k, { mode: 'timed', until })
      sounding.delete(k)
    }
    saveSilences()
    return until
  }

  // Standing silence: for a problem the owner knows about and has decided to
  // live with — a tank running warm all summer, a phosphate they are working
  // down over weeks. It does not expire on a clock. It ends when the condition
  // has actually been gone for a day, at which point the alert is news again.
  state.silenceStanding = (key) => {
    const keys = key ? [key] : state.alerts.active.map((a) => a.key)
    for (const k of keys) {
      silenced.set(k, { mode: 'standing', clearedAt: null })
      sounding.delete(k)
    }
    saveSilences()
    return keys
  }

  // Undo. Every one of the options above is a decision somebody might regret,
  // and a standing silence in particular has no clock to rescue them — without
  // this, "Stop telling me" is a one-way door.
  state.resumeAlarms = (key) => {
    if (key) silenced.delete(key)
    else { silenced.clear(); bypassUntil = 0 }
    saveSilences()
    return true
  }

  // The bypass is deliberately blunt and deliberately temporary: it covers
  // everything, including alerts that have not fired yet, and it cannot be
  // left on by accident because it always expires.
  state.bypassAlarms = (minutes = 360) => {
    bypassUntil = Date.now() + minutes * 60 * 1000
    saveSilences()
    return bypassUntil
  }

  // One tap on the display. The sound stops for this occurrence; nothing else
  // changes - the reading keeps its colour, the ticker carries it.
  state.acknowledgeAlert = (key) => {
    const hit = state.alerts.active.find((a) => a.key === key)
    if (!hit) return null
    const at = Date.now()
    acknowledged.set(key, { at })
    hit.acknowledgedAt = at
    sounding.delete(key)
    saveSilences()
    return at
  }

  state.alarmState = () => ({
    bypassUntil: bypassUntil > Date.now() ? bypassUntil : null,
    silenced: [...silenced.keys()].filter((key) => isSilenced(key)).map((key) => ({
      key,
      mode: silenced.get(key)?.mode ?? 'timed',
      until: silenced.get(key)?.until ?? null
    })),
    sounding: [...sounding.entries()].filter(([, e]) => !e.done).map(([key]) => key)
  })
  const maintSent = new Map()
  const startedAt = Date.now()

  // Active alerts carry their own text now, so the display can render them
  // without knowing what any key means.
  const raise = async (key, title, message, priority, tags, extra = {}) => {
    const existing = state.alerts.active.find((a) => a.key === key)
    if (existing) Object.assign(existing, { message, ...extra })   // keep the numbers current
    else {
      // A restart mid-alert must not re-shout at someone who already tapped it.
      const prior = acknowledged.get(key)
      state.alerts.active.push({ key, title, message, priority, since: Date.now(),
                                 acknowledgedAt: prior?.at ?? null, ...extra })
    }

    const standing = silenced.get(key)
    if (standing?.mode === 'standing' && standing.clearedAt) {
      // It came back before the day was up, so the clock starts over.
      standing.clearedAt = null
      saveSilences()
    }
    soundFor(key, priority)

    if (!pushEnabled) return
    const last = lastSent.get(key)
    if (last && Date.now() - last < cooldownMs) return
    lastSent.set(key, Date.now())
    try {
      await sendNtfy(config, { title, message, priority, tags })
    } catch (err) {
      console.warn('ntfy send failed:', err.message)
    }
  }

  const clear = async (key, message) => {
    // An acknowledgement dies with its occurrence, whether or not the alert is
    // still on the list - it may have resolved while the server was down, and
    // the next time is news again.
    if (acknowledged.delete(key)) saveSilences()
    const idx = state.alerts.active.findIndex((a) => a.key === key)
    if (idx === -1) return
    state.alerts.active.splice(idx, 1)
    lastSent.delete(key)
    sounding.delete(key)
    const entry = silenced.get(key)
    if (entry?.mode === 'standing') {
      // Start the clock rather than dropping the silence: this alert stays
      // quiet until it has been clear for a full day.
      entry.clearedAt = Date.now()
      saveSilences()
    } else if (entry) {
      // A timed silence is forgotten on resolution — the same problem coming
      // back is news again.
      silenced.delete(key)
      saveSilences()
    }
    if (!pushEnabled) return
    try {
      await sendNtfy(config, { title: 'ReefGauge', message, priority: 'low', tags: 'white_check_mark' })
    } catch (err) {
      console.warn('ntfy send failed:', err.message)
    }
  }

  const check = () => {
    const now = Date.now()

    // Tank parameters out of range.
    //
    // Raising and clearing use different thresholds on purpose. A tank sitting
    // at the edge of its range crosses it repeatedly as the water breathes —
    // 79.0, 79.1, 79.0 — and with one threshold that is an alert raising and
    // clearing all day, now with a beep each time. So an alert has to come
    // back inside by a margin before it clears: raise at the edge, clear at
    // the edge minus a slice of the range. The margin scales with the range
    // because pH lives in tenths and calcium in hundreds.
    for (const param of Object.keys(config.apex?.inputs ?? {})) {
      const value = state.tank.latest[param]
      const range = config.ranges?.[param]
      if (value == null || !range) continue
      const meta = PARAM_META[param] ?? { label: param, unit: '' }
      const key = `tank:${param}`
      const margin = (range[1] - range[0]) * hysteresis
      const active = state.alerts.active.find((a) => a.key === key)

      // Which way it broke matters: a reading recovering from LOW must clear
      // the bottom of the band, not the top.
      const dir = active?.dir ?? (value < range[0] ? 'LOW' : 'HIGH')
      const recovered = dir === 'LOW'
        ? value >= range[0] + margin
        : value <= range[1] - margin

      if (active ? !recovered : (value < range[0] || value > range[1])) {
        raise(key, `${meta.label} ${dir}`,
          `${meta.label} is ${value} ${meta.unit} (target ${range[0]}–${range[1]}).`,
          'high', 'warning,droplet', { dir })
      } else {
        clear(key, `${meta.label} back in range: ${value} ${meta.unit}.`)
      }
    }

    // Room CO2 — same reasoning, against the threshold rather than a band.
    const co2 = state.environment?.co2_ppm
    const co2High = config.environment?.co2HighPpm ?? 1500
    if (co2 != null) {
      const co2Active = state.alerts.active.some((a) => a.key === 'env:co2')
      if (co2 >= co2High || (co2Active && co2 > co2High * (1 - hysteresis))) {
        raise('env:co2', 'Room CO2 HIGH', `Room CO2 is ${Math.round(co2)} ppm (limit ${co2High}). Ventilate!`, 'high', 'warning,dash')
      } else {
        clear('env:co2', `Room CO2 back down to ${Math.round(co2)} ppm.`)
      }
    }

    // Apex stopped reporting (grace period after boot)
    if (now - startedAt > APEX_STALE_MS) {
      const stale = !state.tank.updatedAt || now - state.tank.updatedAt > APEX_STALE_MS
      if (stale) {
        raise('apex:offline', 'Apex OFFLINE',
          'No data from the Apex for over 10 minutes — check the controller and network.',
          'urgent', 'rotating_light')
      } else {
        clear('apex:offline', 'Apex is reporting again.')
      }
    }

    // Overdue maintenance — one gentle push per task per day
    if (db) {
      for (const task of db.prepare('SELECT * FROM maint_tasks').all()) {
        const dueAt = task.last_done + task.interval_days * 24 * 3600 * 1000
        const key = `maint:${task.id}`
        if (now > dueAt) {
          const last = maintSent.get(key)
          if (pushEnabled && (!last || now - last > 24 * 3600 * 1000)) {
            maintSent.set(key, now)
            const daysOver = Math.floor((now - dueAt) / (24 * 3600 * 1000))
            sendNtfy(config, {
              title: 'Tank maintenance due',
              message: `${task.name} is ${daysOver > 0 ? `${daysOver} day${daysOver === 1 ? '' : 's'} overdue` : 'due today'}.`,
              priority: 'low',
              tags: 'wrench'
            }).catch((err) => console.warn('ntfy send failed:', err.message))
          }
        } else {
          maintSent.delete(key)
        }
      }
    }

    // Red Sea equipment (skimmer cup full, filter roll out, pump offline…).
    // Each device alert is keyed by device + text so it follows the same
    // raise/cooldown/clear lifecycle as everything else.
    const gearKeys = new Set()
    for (const device of state.redsea?.devices ?? []) {
      for (const alert of device.alerts ?? []) {
        if (alert.level === 'info') continue   // advisory: ticker and equipment view only, no push
        const key = `redsea:${device.id}:${alert.text}`
        gearKeys.add(key)
        raise(key, `${device.name}: attention needed`, alert.text,
          alert.level === 'bad' ? 'high' : 'default', 'warning,shell')
      }
    }
    // Only devices that actually reported this cycle may resolve their alerts.
    // A device that 429'd came back with an empty alert list, so a transient
    // rate-limit cleared every key and pushed "resolved" to the family's
    // phones — while the skimmer cup was still full.
    const respondedIds = new Set(
      (state.redsea?.devices ?? []).filter((d) => d.ok).map((d) => String(d.id))
    )
    const activeGearKeys = state.alerts.active.map((a) => a.key).filter((k) => k.startsWith('redsea:'))
    for (const key of activeGearKeys) {
      const deviceId = key.split(':')[1]
      if (!respondedIds.has(deviceId)) continue // couldn't ask — say nothing
      if (!gearKeys.has(key)) clear(key, `${key.split(':').slice(2).join(':')} — resolved.`)
    }

    // CO2 sensor stopped reporting
    if (now - startedAt > ENV_STALE_MS) {
      const ts = state.environment?.ts
      const stale = !ts || now - ts > ENV_STALE_MS
      if (stale) {
        raise('env:offline', 'CO2 sensor offline', 'No reading from the room sensor for over 15 minutes.', 'default', 'warning')
      } else {
        clear('env:offline', 'CO2 sensor is reporting again.')
      }
    }
  }

  check()
  setInterval(check, CHECK_SECONDS * 1000)

  // An acknowledgement saved for something that is no longer wrong belongs
  // to an occurrence that ended while the server was down; drop it or the
  // next one inherits it. Not at the first check - the pollers have not
  // reported yet and nothing is raised - but once they have had a few
  // minutes to say what is still wrong.
  setTimeout(() => {
    let pruned = false
    for (const key of [...acknowledged.keys()]) {
      if (!state.alerts.active.some((a) => a.key === key)) { acknowledged.delete(key); pruned = true }
    }
    if (pruned) saveSilences()
  }, 3 * 60 * 1000)
}
