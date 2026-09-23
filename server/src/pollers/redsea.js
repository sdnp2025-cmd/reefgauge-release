import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Red Sea "ReefBeat" equipment (ReefMat, ReefRun, ReefLED, ReefDose, ReefATO,
// ReefWave) exposes a small unauthenticated HTTP API on the LAN: /device-info
// identifies the unit and /dashboard carries live state. Red Sea publishes no
// spec, so these shapes were read off real hardware — anything we don't have a
// specific mapper for still renders generically rather than being dropped.
//
// The firmware rate-limits aggressively (HTTP 429), so polling is slow and
// devices are staggered rather than hit in parallel.

const POLL_SECONDS = 60
const STAGGER_MS = 2500
const HTTP_PORT = 80
const PROBE_TIMEOUT_MS = 400
const HTTP_TIMEOUT_MS = 6000

const MODEL_NAMES = {
  'reef-mat': 'ReefMat',
  'reef-run': 'ReefRun',
  'reef-led': 'ReefLED',
  'reef-dose': 'ReefDose',
  'reef-ato': 'ReefATO',
  'reef-wave': 'ReefWave'
}

function prettyName(info) {
  return MODEL_NAMES[info.hw_type] ?? info.hw_model ?? info.hw_type ?? 'Red Sea device'
}

async function fetchJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'reefgauge' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

// ---- Discovery -------------------------------------------------------------

// Every usable host address on the Pi's own IPv4 subnet.
function subnetHosts() {
  const out = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const ip = ipToInt(a.address)
      const mask = ipToInt(a.netmask)
      const size = (~mask >>> 0) + 1
      if (size > 4096) continue // don't sweep anything larger than a /20
      const network = (ip & mask) >>> 0
      for (let i = 1; i < size - 1; i++) out.push(intToIp((network + i) >>> 0))
    }
  }
  return out
}

const ipToInt = (s) => s.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0)
const intToIp = (n) => [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.')

function portOpen(ip) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(HTTP_PORT, ip)
  })
}

async function mapLimited(items, limit, fn) {
  const out = []
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// Identify one device by IP. Throws when nothing ReefBeat-shaped answers, which
// is how the setup wizard validates a hand-typed address.
export async function probeRedSeaDevice(ip) {
  const info = await fetchJson(`http://${ip}/device-info`, 4000)
  if (!info?.hwid || !info?.hw_type) throw new Error('not a Red Sea device')
  let headline = 'Online'
  try {
    headline = summarize(info, await fetchJson(`http://${ip}/dashboard`, 4000)).headline
  } catch {
    // dashboard is optional for identification (it may be rate-limiting)
  }
  return { ip, hwid: info.hwid, type: info.hw_type, model: info.hw_model ?? null, name: prettyName(info), headline }
}

// Sweeps the local subnet for anything answering /device-info like a ReefBeat unit.
export async function discoverRedSea() {
  const hosts = subnetHosts()
  if (!hosts.length) return []
  const reachable = []
  await mapLimited(hosts, 120, async (ip) => {
    if (await portOpen(ip)) reachable.push(ip)
  })

  const found = []
  await mapLimited(reachable, 6, async (ip) => {
    try {
      found.push(await probeRedSeaDevice(ip))
    } catch {
      // not a ReefBeat device
    }
  })
  return found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))
}

// ---- Per-device state mapping ---------------------------------------------

function reefMat(dash) {
  const level = dash.roll_level ?? 'unknown'
  const days = dash.days_till_end_of_roll
  const alerts = []
  if (level === 'empty' || dash.mode === 'end_of_roll') {
    alerts.push({ level: 'bad', text: 'Roll empty — replace the filter roll' })
  } else if (typeof days === 'number' && days <= 3) {
    alerts.push({ level: 'warn', text: `Roll nearly out — ~${days} day${days === 1 ? '' : 's'} left` })
  }
  if (dash.unclean_sensor) alerts.push({ level: 'warn', text: 'Optical sensor needs cleaning' })
  return {
    headline: level === 'empty' ? 'Roll empty' : `Roll ${level}`,
    metrics: [
      { label: 'Roll', value: level },
      { label: 'Days left', value: typeof days === 'number' ? String(days) : '—' },
      { label: 'Material', value: dash.material?.name ?? '—' },
      { label: 'Used', value: dash.total_usage != null ? `${Math.round(dash.total_usage)} m` : '—' }
    ],
    alerts
  }
}

// Advisory above the warm line, alarm above the hot line. Red Sea's return
// pumps report their motor temperature; mid-40s is the top of normal for a
// pump with a clean intake in a 78°F sump.
const PUMP_WARM_C = 45
const PUMP_HOT_C = 55

function reefRun(dash) {
  const pumps = Object.keys(dash)
    .filter((k) => /^pump_\d+$/.test(k))
    .map((k) => dash[k])
    .filter(Boolean)
  const alerts = []
  const metrics = []
  for (const p of pumps) {
    // The ReefBeat app names a pump "Pump2" unless the owner renames it,
    // which nobody does for the return pump - so "Skimmer · full cup, Pump2
    // · 75%" read like one pump and a mystery. Fall back to what the pump
    // IS when the name is the app's default.
    const TYPE_NAMES = { return: 'Return pump', skimmer: 'Skimmer', wavemaker: 'Wave pump' }
    const generic = !p.name || /^pump\s*\d*$/i.test(p.name)
    const name = (generic && TYPE_NAMES[p.type]) || p.name || p.type || 'Pump'
    if (p.missing_pump) alerts.push({ level: 'bad', text: `${name} not connected` })
    else if (p.state === 'full-cup') alerts.push({ level: 'warn', text: `${name} collection cup full` })
    else if (p.state && !['operational', 'running', 'idle'].includes(p.state)) {
      alerts.push({ level: 'warn', text: `${name}: ${String(p.state).replace(/-/g, ' ')}` })
    }
    if (p.missing_sensor && p.sensor_controlled) alerts.push({ level: 'warn', text: `${name} sensor missing` })
    // Motor temperature. These DC pumps run warm, but a pump creeping up is
    // the earliest sign of a fouled intake or a worn bearing - so it is an
    // advisory (maintenance might be needed), not an alarm, until it is hot.
    const t = Number(p.temperature)
    if (Number.isFinite(t) && t > 0 && p.state !== 'full-cup') {
      const f = Math.round(t * 9 / 5 + 32)
      if (t >= PUMP_HOT_C) alerts.push({ level: 'bad', text: `${name} running hot (${f}°F / ${Math.round(t)}°C) — check it now` })
      else if (t >= PUMP_WARM_C) alerts.push({ level: 'info', text: `${name} running warm (${f}°F) — maintenance may be needed` })
    }
    metrics.push({
      label: name,
      value: p.state === 'operational' ? `${Math.round(p.intensity ?? 0)}%` : String(p.state ?? '—').replace(/-/g, ' ')
    })
  }
  return { headline: `${pumps.length} pump${pumps.length === 1 ? '' : 's'}`, metrics, alerts }
}

// Fallback for Red Sea gear we haven't hand-mapped yet (ReefLED, ReefDose, …):
// surface the dashboard's own scalar fields so the device still appears.
function generic(dash) {
  const metrics = []
  for (const [k, v] of Object.entries(dash ?? {})) {
    if (metrics.length >= 6) break
    if (v == null || typeof v === 'object') continue
    if (typeof v === 'boolean' && v === false) continue
    if (['success', 'message', 'is_internet_connected', 'synced', 'linked'].includes(k)) continue
    metrics.push({ label: k.replace(/_/g, ' '), value: String(v) })
  }
  return { headline: dash?.mode ? String(dash.mode).replace(/_/g, ' ') : 'Online', metrics, alerts: [] }
}

function summarize(info, dash) {
  if (info.hw_type === 'reef-mat') return reefMat(dash)
  if (info.hw_type === 'reef-run') return reefRun(dash)
  return generic(dash)
}

// ---- Poller ----------------------------------------------------------------

// What the config may say about equipment, and what it may not:
//   names    hwid -> what the customer calls it
//   exclude  hwids the customer hid in the Equipment step
//   hosts    addresses the customer typed in for units discovery cannot reach
//            (another subnet); polled in addition to whatever is discovered
// It never records WHERE a discovered device was. Earlier builds wrote the
// IPs the wizard found into `devices`, which pinned the unit to two DHCP
// leases and switched discovery off - a ReefDose bought a month later would
// never have appeared. A leftover `devices` list is now only a hint for the
// first poll; discovery stays on.
const RESCAN_MS = 6 * 60 * 60 * 1000       // look for new equipment this often, unprompted

export function startRedSeaPoller(config, state, dataDir) {
  const cfg = config.redSea ?? {}
  if (cfg.enabled === false) return

  const cacheFile = path.join(dataDir, 'redsea-devices.json')
  const nicknames = cfg.names ?? {}
  const excluded = new Set(cfg.exclude ?? [])
  const manualHosts = (cfg.hosts ?? []).map((ip) => ({ ip, manual: true }))
  state.redsea = { devices: [], hidden: [], updatedAt: null, discovering: false, error: null }

  const loadCache = () => {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    } catch {
      return []
    }
  }
  const saveCache = (list) => {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(list, null, 2))
    } catch (err) {
      console.warn('Red Sea: could not cache device list:', err.message)
    }
  }

  // The manual hosts are always polled; discovered ones come and go with the
  // network. The cache (and, once, a legacy `devices` list) only seeds the
  // first poll so the screen is not empty while the first sweep runs.
  const withManual = (list) => {
    const seen = new Set(list.map((d) => d.ip))
    return [...list, ...manualHosts.filter((m) => !seen.has(m.ip))]
  }
  let devices = withManual(loadCache().length ? loadCache() : (cfg.devices ?? []).map((ip) => ({ ip })))
  let failuresSinceDiscovery = 0
  let lastDiscovery = 0

  const rediscover = async () => {
    if (state.redsea.discovering) return
    state.redsea.discovering = true
    try {
      const found = await discoverRedSea()
      lastDiscovery = Date.now()
      if (found.length) {
        const discovered = found.map((f) => ({ ip: f.ip, hwid: f.hwid }))
        devices = withManual(discovered)
        state.redsea.error = null
        saveCache(discovered)
        failuresSinceDiscovery = 0
        console.log(`Red Sea: discovered ${discovered.length} device(s): ${discovered.map((d) => d.ip).join(', ')}`)
      }
    } catch (err) {
      console.warn('Red Sea discovery failed:', err.message)
    } finally {
      state.redsea.discovering = false
    }
  }

  const pollDevice = async (dev) => {
    const info = await fetchJson(`http://${dev.ip}/device-info`)
    const dash = await fetchJson(`http://${dev.ip}/dashboard`)
    const { headline, metrics, alerts } = summarize(info, dash)
    return {
      ok: true,
      id: info.hwid ?? dev.ip,
      ip: dev.ip,
      type: info.hw_type ?? null,
      model: info.hw_model ?? null,
      name: nicknames[info.hwid] ?? nicknames[info.hw_type] ?? prettyName(info),
      headline,
      metrics,
      alerts,
      // The device's own dashboard, so the equipment detail view can show
      // everything it reports without costing another (rate-limited) request.
      raw: dash,
      error: null
    }
  }

  const run = async () => {
    if (!devices.length || Date.now() - lastDiscovery > RESCAN_MS) await rediscover()
    const results = []
    const hidden = []
    for (const dev of devices) {
      try {
        const polled = await pollDevice(dev)
        // Hidden by the customer: kept aside so the Equipment step can offer
        // it back, but never on the dashboard and never alerting.
        ;(excluded.has(polled.id) ? hidden : results).push(polled)
      } catch (err) {
        failuresSinceDiscovery++
        const prev = state.redsea.devices.find((d) => d.ip === dev.ip)
        results.push({
          id: dev.hwid ?? dev.ip,
          ip: dev.ip,
          type: prev?.type ?? null,
          model: prev?.model ?? null,
          name: prev?.name ?? nicknames[dev.hwid] ?? 'Red Sea device',
          headline: 'Offline',
          metrics: [],
          alerts: [{ level: 'warn', text: `${prev?.name ?? dev.ip} not responding` }],
          // The firmware rate-limits with 429, so a failed read is routine and
          // says nothing about the tank. Alerting must not read the empty
          // alert list as "problem resolved".
          ok: false,
          error: err.message
        })
      }
      await new Promise((r) => setTimeout(r, STAGGER_MS))
    }
    state.redsea.devices = results
    state.redsea.hidden = hidden
    state.redsea.updatedAt = Date.now()

    // A device may have moved to a new DHCP lease — rescan after repeated misses.
    if (failuresSinceDiscovery >= devices.length * 3) {
      failuresSinceDiscovery = 0
      rediscover()
    }
  }

  run().catch((err) => console.warn('Red Sea poll failed:', err.message))
  setInterval(() => run().catch((err) => console.warn('Red Sea poll failed:', err.message)), POLL_SECONDS * 1000)
}
