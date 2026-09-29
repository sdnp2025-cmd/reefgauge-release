// Polls a Neptune Apex on the LAN. Tries the modern AOS REST API first
// (session login + /rest/status), then falls back to the classic
// /cgi-bin/status.json with basic auth for older firmware.

import fs from 'node:fs'
import { onClockStep, shift } from '../clock.js'
import { saveConfigAtomic } from '../config.js'

let sessionCookie = null

async function loginAos(apex) {
  const res = await fetch(`http://${apex.host}/rest/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: apex.username, password: apex.password, remember_me: false }),
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`AOS login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) sessionCookie = setCookie.split(';')[0]
}

async function fetchAosStatus(apex) {
  if (!sessionCookie) await loginAos(apex)
  let res = await fetch(`http://${apex.host}/rest/status`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
    signal: AbortSignal.timeout(10000)
  })
  if (res.status === 401 || res.status === 403) {
    await loginAos(apex)
    res = await fetch(`http://${apex.host}/rest/status`, {
      headers: { Cookie: sessionCookie },
      signal: AbortSignal.timeout(10000)
    })
  }
  if (!res.ok) throw new Error(`AOS status failed: ${res.status}`)
  return res.json()
}

async function fetchClassicStatus(apex) {
  const auth = Buffer.from(`${apex.username}:${apex.password}`).toString('base64')
  const res = await fetch(`http://${apex.host}/cgi-bin/status.json`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`Classic status failed: ${res.status}`)
  return res.json()
}

function extractInputs(data) {
  const inputs = data?.istat?.inputs ?? data?.inputs ?? data?.status?.inputs ?? []
  return inputs.map((i) => ({
    name: i.name ?? i.did,
    type: i.type ?? '',
    value: Number(i.value)
  }))
}

// Fetch the live input list from an Apex (also used by the setup wizard
// to verify a discovered controller and auto-map its inputs).
export async function fetchApexInputs(apex) {
  let data
  try {
    data = await fetchAosStatus(apex)
  } catch {
    data = await fetchClassicStatus(apex)
  }
  return extractInputs(data)
}

// Start an Apex feed cycle (pauses pumps per the user's Fusion feed settings).
// Tries the AOS REST endpoint, falls back to the classic CGI form.
// Marked best-effort: verify against real hardware, firmware variants differ.
export async function startFeedCycle(apex, feed = 'A') {
  const feedNum = { A: 1, B: 2, C: 3, D: 4 }[String(feed).toUpperCase()] ?? Number(feed) ?? 1
  try {
    if (!sessionCookie) await loginAos(apex)
    const res = await fetch(`http://${apex.host}/rest/status/feed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
      body: JSON.stringify({ name: feedNum, active: 1 }),
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) return true
    throw new Error(`AOS feed ${res.status}`)
  } catch {
    const auth = Buffer.from(`${apex.username}:${apex.password}`).toString('base64')
    const res = await fetch(`http://${apex.host}/cgi-bin/status.cgi`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ FeedSel: String(feedNum - 1), FeedCycle: 'Feed' }),
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`feed cycle failed: ${res.status}`)
    return true
  }
}

// When a Trident/Trident NP comes (back) online, its typed inputs appear in
// the inventory — adopt them into any unmapped parameter slots automatically
// so gauges light up without re-running setup (e.g. unit returns from service).
const ADOPTABLE_TYPES = { alk: 'alk', ca: 'ca', mg: 'mg', no3: 'no3', po4: 'po4' }

function adoptReturningInputs(config, inputs) {
  const mapped = new Set(Object.values(config.apex.inputs ?? {}))
  let changed = false
  for (const [param, type] of Object.entries(ADOPTABLE_TYPES)) {
    // `param in inputs` rather than a truthiness check: the mapping screen
    // writes an explicit null to mean "there is no probe for this", and a
    // falsy test treated that as an empty slot and adopted something into it
    // on the next poll - overruling the person who had just said otherwise.
    if (Object.prototype.hasOwnProperty.call(config.apex.inputs, param)) continue
    const input = inputs.find((i) => !mapped.has(i.name) && String(i.type).toLowerCase() === type)
    if (!input) continue
    config.apex.inputs[param] = input.name
    mapped.add(input.name)
    changed = true
    console.log(`Apex: adopted input "${input.name}" as ${param}`)
  }
  if (changed && !config.isExample && config.configPath) {
    try {
      const onDisk = JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      onDisk.apex = { ...onDisk.apex, inputs: { ...onDisk.apex?.inputs, ...config.apex.inputs } }
      // Atomically. This runs on a background timer, unattended, on a device
      // that gets unplugged - which is precisely the case saveConfigAtomic was
      // written for. A plain write here could tear the customer's entire
      // configuration in half at any moment, with nobody at the screen.
      saveConfigAtomic(config.configPath, onDisk)
    } catch (err) {
      console.warn('Could not persist adopted inputs:', err.message)
    }
  }
}

async function pollOnce(config, state, db) {
  const apex = config.apex
  const inputs = await fetchApexInputs(apex)
  adoptReturningInputs(config, inputs)
  state.tank.inputs = inputs

  const insert = db.prepare('INSERT INTO tank_readings (ts, param, value) VALUES (?, ?, ?)')
  const now = Date.now()
  // Remember what we stamped rows with, so a later clock correction can find
  // exactly those rows again. Only ours: a boot clock is the time of the last
  // shutdown, so "rows dated around then" would also match genuine readings
  // from that evening, and shifting those would corrupt real history.
  stampedSinceStep.add(now)
  const latest = {}

  // One transaction: a partial write used to be able to leave a half-recorded
  // sample behind, which the trend charts then read as real.
  const writeAll = db.transaction((rows) => {
    for (const [param, value] of rows) insert.run(now, param, value)
  })

  for (const [param, inputName] of Object.entries(apex.inputs)) {
    const input = inputs.find((i) => i.name === inputName)
    if (!input || Number.isNaN(input.value)) continue
    latest[param] = input.value
  }
  writeAll(Object.entries(latest))

  // Freshness is stamped LAST, and only once the readings are both stored and
  // published. It used to be set before the insert loop, so a failing database
  // (full card, read-only filesystem) left the poll looking healthy: alerts
  // kept evaluating stale values and the "Apex offline" alarm never fired,
  // because staleness is computed purely from updatedAt.
  state.tank.latest = latest
  state.tank.updatedAt = Date.now()
  state.tank.error = null
}

// Wall-clock instants this process has written to tank_readings since the last
// clock correction.
const stampedSinceStep = new Set()

export function startApexPoller(config, state, db) {
  const intervalMs = (config.apex.pollSeconds ?? 60) * 1000
  const run = async () => {
    try {
      await pollOnce(config, state, db)
    } catch (err) {
      state.tank.error = String(err.message ?? err)
      console.warn('Apex poll failed:', state.tank.error)
    }
  }
  run()
  setInterval(run, intervalMs)

  // The clock just moved, so the reading we are holding is now wrongly dated
  // and everything downstream believes it is ancient. Go and get a real one
  // rather than waiting out the poll interval with the alarm sounding.
  onClockStep((delta) => {
    // Shift rather than clear. The reading we are holding was taken seconds
    // ago and still was - only the numbering of the clock changed. Clearing it
    // would read as "no data", which downstream treats as offline, which is
    // the alarm this exists to prevent.
    state.tank.updatedAt = shift(state.tank.updatedAt, delta)
    state.tank.feedUntil = shift(state.tank.feedUntil, delta)

    // Rows written before the correction carry the wrong date. Left alone they
    // are not lost, they are worse: a reading taken at boot appears on the
    // trend twenty hours back, with a plausible value, and the chart quietly
    // tells a story that did not happen.
    if (stampedSinceStep.size) {
      const stamps = [...stampedSinceStep]
      stampedSinceStep.clear()
      try {
        const fix = db.prepare('UPDATE tank_readings SET ts = ts + ? WHERE ts = ?')
        const fixAll = db.transaction((list) => { for (const ts of list) fix.run(delta, ts) })
        fixAll(stamps)
        console.warn(`re-dated ${stamps.length} reading(s) written before the clock was set`)
      } catch (err) {
        console.warn('could not re-date readings after the clock changed:', err.message)
      }
    }
    // Then go and get a genuinely current one, rather than waiting out the
    // poll interval on a terminal that has just booted.
    run()
  })
}
