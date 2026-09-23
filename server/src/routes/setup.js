// First-boot setup wizard API: Wi-Fi provisioning (via NetworkManager),
// Apex discovery on the LAN and location lookup.
// The wizard UI runs on the terminal's own touchscreen (served from
// localhost), so no network is needed to reach it on first power-up.
//
// Wi-Fi uses `sudo nmcli` — pi/install.sh installs a sudoers rule allowing
// exactly that command. NetworkManager persists connections across reboots.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import QRCode from 'qrcode'
import { fetchApexInputs } from '../pollers/apex.js'
import { discoverRedSea, probeRedSeaDevice } from '../pollers/redsea.js'
import { mintSession, sessionFor, isLocalRequest, SESSION_TTL_MS } from '../phoneSession.js'
import { lanIp } from '../lan.js'
import { DOSING_METHODS, methodFor } from '../dosingMethods.js'

const exec = promisify(execFile)

const DEMO = !!process.env.DEMO

let demoSsid = null

async function nmcli(args) {
  const { stdout } = await exec('sudo', ['nmcli', ...args], { timeout: 45000 })
  return stdout
}

// nmcli -t escapes ':' inside fields as '\:'
function splitFields(line) {
  return line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'))
}

// Even patient is too slow for a screen: the first probe after a boot spends
// seconds on a cold DNS lookup, and the whole settings list waited behind it.
// So the list never waits — it reads the last answer and starts a new probe
// for next time. `null` means nobody has found out yet, which the card draws
// as nothing rather than as "no internet"; guessing "offline" while the guess
// is still in flight is how a working network gets reported as broken.
let onlineCache = { value: null, at: 0 }
const ONLINE_TTL_MS = 60 * 1000

function cachedOnline() {
  if (Date.now() - onlineCache.at > ONLINE_TTL_MS) {
    onlineCheck(5000)
      .then((value) => { onlineCache = { value, at: Date.now() } })
      .catch(() => { onlineCache = { value: null, at: Date.now() } })
  }
  return onlineCache.value
}

// Deliberately NOT `nmcli dev wifi`: that lists access points, and listing
// access points makes NetworkManager start a scan whenever its cached one is
// more than about half a minute old. Asking "what am I connected to" then took
// four seconds — long enough that the settings screen drew every card as empty
// before the answer arrived, which is how a connected terminal came to report
// "Not connected". Device state is a local lookup and never scans.
async function wifiStatus() {
  if (DEMO) return { connected: demoSsid != null, ssid: demoSsid }
  try {
    const out = await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'])
    const row = out.split('\n').map(splitFields).find((f) => f[1] === 'wifi' && f[2] === 'connected')
    if (!row) return { connected: false, ssid: null }
    // The profile name is usually the SSID but does not have to be, so read
    // the SSID off the profile rather than reporting whatever it was named.
    let ssid = row[3] || null
    try {
      const actual = await nmcli(['-g', '802-11-wireless.ssid', 'connection', 'show', row[3]])
      if (actual.trim()) ssid = actual.trim()
    } catch { /* profile renamed mid-call; the connection name will do */ }
    return { connected: true, ssid }
  } catch {
    return { connected: false, ssid: null }
  }
}

// The timeout is a parameter because the two callers want different things:
// the Wi-Fi step is waiting on this answer and can afford to be patient, while
// the settings list is drawing ten other cards behind it.
async function onlineCheck(timeoutMs = 5000) {
  try {
    const res = await fetch('https://connectivitycheck.gstatic.com/generate_204', {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.status === 204 || res.ok
  } catch {
    return false
  }
}

async function probeApex(host, timeoutMs = 900) {
  try {
    const res = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.text()).slice(0, 4000)
    return /apex|neptune/i.test(body) || /apex/i.test(res.headers.get('server') ?? '')
  } catch {
    return false
  }
}

async function scanForApex() {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 1200))
    return [{ host: '192.168.1.50', label: 'Apex (demo)' }]
  }
  const found = []
  if (await probeApex('apex.local', 2000)) found.push({ host: 'apex.local', label: 'apex.local' })

  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
  for (const net of nets) {
    const base = net.address.split('.').slice(0, 3).join('.')
    const hosts = []
    for (let n = 1; n <= 254; n++) {
      const host = `${base}.${n}`
      if (host !== net.address) hosts.push(host)
    }
    const BATCH = 32
    for (let i = 0; i < hosts.length; i += BATCH) {
      const results = await Promise.all(hosts.slice(i, i + BATCH).map(async (h) => (await probeApex(h)) ? h : null))
      for (const h of results.filter(Boolean)) found.push({ host: h, label: h })
    }
  }
  return found
}

// Map Apex inputs onto our eight parameters. The Apex labels each input with
// a type (Temp/pH/Cond, and Trident inputs as alk/ca/mg/no3/po4) — match on
// that first; name patterns are only a fallback. Lesson from real hardware:
// name-guessing grabbed "CalcPH" (a calcium-reactor pH probe) for calcium.
const PARAM_ORDER = ['temp', 'ph', 'salinity', 'alk', 'ca', 'mg', 'no3', 'po4']
const TYPE_OF = {
  temp: 'temp', ph: 'ph', salinity: 'cond',
  alk: 'alk', ca: 'ca', mg: 'mg', no3: 'no3', po4: 'po4'
}
const NAME_FALLBACK = {
  temp: (n) => /^tmp$|^temp/i.test(n),
  ph: (n) => /^ph$/i.test(n),
  salinity: (n) => /cond|salt|salin/i.test(n),
  alk: (n) => /^alk/i.test(n),
  ca: (n) => /^ca(?!lc)/i.test(n),
  mg: (n) => /^mg/i.test(n) || /magn/i.test(n),
  no3: (n) => /no3|nitrat/i.test(n),
  po4: (n) => /po4|phosph/i.test(n)
}

function autoMapInputs(inputs) {
  const used = new Set()
  const mapping = {}
  const values = {}
  for (const param of PARAM_ORDER) {
    let candidates = inputs.filter((i) => !used.has(i.name) && String(i.type).toLowerCase() === TYPE_OF[param])
    if (param === 'ph' || param === 'temp') {
      // the display tank probe, not a reactor/equipment probe (CalcPH, Tmpx12…)
      const exact = candidates.find((i) => i.name.toLowerCase() === (param === 'ph' ? 'ph' : 'tmp'))
      if (exact) candidates = [exact]
      else candidates = candidates.filter((i) => !/calc|react/i.test(i.name))
    }
    const input = candidates[0] ?? inputs.find((i) => !used.has(i.name) && NAME_FALLBACK[param](i.name))
    if (!input) continue
    used.add(input.name)
    mapping[param] = input.name
    values[param] = input.value
  }
  return { mapping, values }
}

const DEMO_INPUTS = [
  { name: 'Tmp', type: 'Temp', value: 78.1 }, { name: 'pH', type: 'pH', value: 8.24 },
  { name: 'Cond', type: 'Cond', value: 35.0 }, { name: 'Alkx15', type: 'alk', value: 7.3 },
  { name: 'Cax15', type: 'ca', value: 428 }, { name: 'Mgx15', type: 'mg', value: 1320 },
  { name: 'NO3', type: 'no3', value: 5.2 }, { name: 'PO4', type: 'po4', value: 0.06 }
]

export default async function setupRoutes(app, { config, state }) {
  let version = 'dev'
  try { version = fs.readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim() } catch {}

  // Positive check only. This used to read `config.setupComplete !== false`,
  // so a unit whose config.json was copied straight from the example — which
  // is exactly what install.sh does — reported itself already set up. The
  // wizard was skipped and the unit ran on example values forever.
  app.get('/api/setup/status', async () => ({
    complete: DEMO ? true : config.setupComplete === true,
    demo: DEMO,
    version
  }))

  app.get('/api/setup/wifi/status', async () => ({
    ...(await wifiStatus()),
    online: await onlineCheck()
  }))

  app.get('/api/setup/wifi/networks', async () => {
    if (DEMO) {
      return {
        networks: [
          { ssid: 'HomeNet-5G', signal: 88, security: 'WPA2' },
          { ssid: 'HomeNet', signal: 72, security: 'WPA2' },
          { ssid: 'Neighbors WiFi', signal: 45, security: 'WPA3' },
          { ssid: 'CoffeeShack Guest', signal: 28, security: '' }
        ]
      }
    }
    const out = await nmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'yes'])
    const best = new Map()
    for (const line of out.split('\n').filter(Boolean)) {
      const [ssid, signal, security] = splitFields(line)
      if (!ssid) continue
      const entry = { ssid, signal: Number(signal), security }
      if (!best.has(ssid) || best.get(ssid).signal < entry.signal) best.set(ssid, entry)
    }
    return { networks: [...best.values()].sort((a, b) => b.signal - a.signal) }
  })

// `nmcli dev wifi connect` looks the SSID up in the scan cache and infers the
// security type from the AP it finds. When the AP is not in that cache — a
// hidden network, a stale scan, or a band that dropped out between the list
// and the tap — it has nothing to infer from, builds a half-finished security
// section, and fails with "802-11-wireless-security.key-mgmt: property is
// missing". Which is a true statement about its own data structure and tells
// the person standing at the terminal nothing at all.
//
// So we never let it guess. We read the security type ourselves, write an
// explicit profile, and bring that up.

async function wifiDevice() {
  const out = await nmcli(['-t', '-f', 'DEVICE,TYPE', 'device'])
  const row = out.split('\n').map(splitFields).find((f) => f[1] === 'wifi')
  return row?.[0] ?? 'wlan0'
}

// The SECURITY column is a space-separated list like "WPA1 WPA2", "WPA3",
// "WPA2 802.1X", or empty for an open network.
function keyMgmtFor(security, password) {
  const sec = (security ?? '').toUpperCase()
  if (/802\.1X/.test(sec)) return null              // enterprise: needs more than a password
  if (/WPA3|SAE/.test(sec)) return 'sae'
  if (/WPA|WEP|RSN/.test(sec)) return 'wpa-psk'
  // Not in the scan: assume the common case rather than refusing. A password
  // typed in means the person believes it is secured, and that is far more
  // often right than a scan that missed the AP.
  return password ? 'wpa-psk' : null
}

// Any profile that already claims this SSID, so a half-written or
// wrong-password leftover cannot poison the new attempt.
async function profilesForSsid(ssid) {
  const out = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show'])
  const names = out.split('\n').map(splitFields)
    .filter((f) => f[1] === '802-11-wireless').map((f) => f[0])
  const matches = []
  for (const name of names) {
    if (name === ssid) { matches.push(name); continue }
    try {
      const s = await nmcli(['-g', '802-11-wireless.ssid', 'connection', 'show', name])
      if (s.trim() === ssid) matches.push(name)
    } catch { /* profile vanished mid-list */ }
  }
  return matches
}

async function activeWifiProfile(dev) {
  try {
    const out = await nmcli(['-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active'])
    return out.split('\n').map(splitFields).find((f) => f[1] === dev)?.[0] ?? null
  } catch {
    return null
  }
}

async function connectWifi(ssid, password) {
  const list = await nmcli(['-t', '-f', 'SSID,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'])
  const seen = list.split('\n').map(splitFields).find((f) => f[0] === ssid)
  const security = seen?.[1] ?? ''
  if (/802\.1X/i.test(security)) {
    throw new Error('This network needs a company or school login, which this screen cannot do yet.')
  }
  const keyMgmt = keyMgmtFor(security, password)
  if (keyMgmt && !password) throw new Error('This network needs a password.')
  if (keyMgmt === 'wpa-psk' && password.length < 8) {
    throw new Error('Wi-Fi passwords are at least 8 characters.')
  }

  const dev = await wifiDevice()
  const wasActive = await activeWifiProfile(dev)
  const clashes = await profilesForSsid(ssid)

  // Build the new profile alongside the old one rather than in place of it.
  // Deleting first is how a mistyped password turns a wall panel into a brick
  // on a shelf: the profile that worked is gone, the new one cannot connect,
  // and the screen that would let you fix it is the screen you just cut off.
  const temp = clashes.includes(ssid) ? `${ssid} (new)` : ssid
  try { await nmcli(['connection', 'delete', temp]) } catch { /* nothing to clear */ }

  const add = [
    'connection', 'add', 'type', 'wifi', 'con-name', temp, 'ifname', dev,
    'ssid', ssid,
    // Not in the scan means either a hidden network or one the radio missed;
    // marking it hidden connects both, and costs a probe request otherwise.
    '802-11-wireless.hidden', seen ? 'no' : 'yes',
    'connection.autoconnect', 'yes'
  ]
  if (keyMgmt) add.push('wifi-sec.key-mgmt', keyMgmt, 'wifi-sec.psk', password)
  await nmcli(add)

  try {
    // nmcli's own default wait is longer than our exec timeout, and a killed
    // nmcli leaves the radio mid-association with nobody tidying up. Let it
    // give up cleanly first.
    await nmcli(['--wait', '30', 'connection', 'up', temp])
  } catch (err) {
    try { await nmcli(['connection', 'delete', temp]) } catch { /* fine */ }
    // Bringing up the new profile took the radio away from the old one. Put it
    // back, so a failed attempt costs nothing but the attempt.
    if (wasActive && wasActive !== temp) {
      try { await nmcli(['connection', 'up', wasActive]) } catch { /* out of range now */ }
    }
    throw err
  }

  // Connected. Now the old profiles for this SSID are the stale ones, and the
  // new one can take the plain name.
  for (const name of clashes) {
    if (name === temp) continue
    try { await nmcli(['connection', 'delete', name]) } catch { /* already gone */ }
  }
  if (temp !== ssid) {
    try { await nmcli(['connection', 'modify', temp, 'connection.id', ssid]) } catch { /* cosmetic */ }
  }
}

  app.post('/api/setup/wifi/connect', async (req, reply) => {
    const { ssid, password } = req.body ?? {}
    if (!ssid) return reply.code(400).send({ error: 'ssid required' })
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 1500))
      if (password && password.length < 8) return reply.code(400).send({ error: 'Wrong password (demo wants 8+ characters)' })
      demoSsid = ssid
      return { ok: true, ssid }
    }
    try {
      await connectWifi(ssid, password ?? '')
      return { ok: true, ssid }
    } catch (err) {
      const msg = String(err.stderr ?? err.message ?? err).trim()
      // nmcli's own wording is written for someone reading a terminal, not for
      // someone holding a wall panel. Translate the cases we can name.
      let friendly = msg
      if (/secrets were required|802-11-wireless-security|invalid.*psk|key-mgmt/i.test(msg)) {
        friendly = 'Wrong password — try again.'
      } else if (/no network with ssid|not found/i.test(msg)) {
        friendly = `Could not find ${ssid}. Check the name, and that the terminal is in range.`
      } else if (/timeout|timed out/i.test(msg)) {
        friendly = 'The network did not answer. Move closer, or try again.'
      }
      return reply.code(400).send({ error: friendly })
    }
  })

  app.post('/api/setup/apex/scan', async () => ({ found: await scanForApex() }))

  // ---- Red Sea equipment ----
  // The wizard's Equipment step: scan the LAN for ReefBeat gear, or add a unit
  // by IP when it lives on another subnet. Re-runnable from ⚙️ whenever the
  // customer's equipment changes.
  app.post('/api/setup/redsea/scan', async () => {
    if (DEMO) {
      return {
        found: [
          { ip: '192.168.1.24', hwid: 'demo-mat', type: 'reef-mat', model: 'RSMAT', name: 'ReefMat', headline: 'Roll 62%' },
          { ip: '192.168.1.29', hwid: 'demo-run', type: 'reef-run', model: 'RSRUN', name: 'ReefRun', headline: '2 pumps' }
        ]
      }
    }
    return { found: await discoverRedSea() }
  })

  app.post('/api/setup/redsea/probe', async (req, reply) => {
    const ip = (req.body?.ip ?? '').trim()
    if (!ip) return reply.code(400).send({ error: 'ip required' })
    try {
      return { ok: true, device: await probeRedSeaDevice(ip) }
    } catch (err) {
      return reply.code(400).send({ error: `No Red Sea device answered at ${ip}: ${err.message}` })
    }
  })

  app.post('/api/setup/apex/verify', async (req, reply) => {
    const { host, username = 'admin', password = '1234' } = req.body ?? {}
    if (!host) return reply.code(400).send({ error: 'host required' })
    try {
      const inputs = DEMO ? DEMO_INPUTS : await fetchApexInputs({ host, username, password })
      const { mapping, values } = autoMapInputs(inputs)
      return { ok: true, inputs, mapping, values }
    } catch (err) {
      return reply.code(400).send({ error: `Could not read the Apex: ${err.message}` })
    }
  })

  app.get('/api/setup/location', async (req, reply) => {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return { results: [] }
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`
      const data = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json()
      return {
        results: (data.results ?? []).map((r) => ({
          label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
          latitude: r.latitude,
          longitude: r.longitude
        }))
      }
    } catch (err) {
      return reply.code(502).send({ error: String(err.message ?? err) })
    }
  })

  // What a phone code can be good for. Photos always; lab results and coral
  // photos when minted from those screens.
  const PHONE_SCOPES = new Set(['photos', 'icp', 'corals'])

  app.get('/api/setup/qr', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'codes can only be created on the terminal itself' })
    }
    const asked = String(req.query.scope ?? 'photos').split(',').map((s) => s.trim())
    const scopes = asked.filter((s) => PHONE_SCOPES.has(s))
    if (!scopes.length) return reply.code(400).send({ error: 'no valid scope requested' })

    const { nonce, expiresAt } = mintSession(scopes)
    const url = `http://${lanIp()}:${config.port ?? 8080}/?rt=${nonce}`
    return {
      url,
      scopes,
      expiresAt,
      expiresInMinutes: Math.round(SESSION_TTL_MS / 60000),
      svg: await QRCode.toString(url, { type: 'svg', margin: 1 })
    }
  })

  // The phone page asks what its code is good for (which tabs to show) and
  // finds out here when the code has run out.
  app.get('/api/setup/session', async (req, reply) => {
    if (isLocalRequest(req)) return { ok: true, scopes: [...PHONE_SCOPES], local: true }
    const session = sessionFor(req, null)
    if (!session) {
      return reply.code(403).send({ error: 'scan the code on the terminal again — this link has expired' })
    }
    return { ok: true, scopes: session.scopes, expiresAt: session.expires }
  })

  // Factory reset from the screen. install.sh --factory does this on the build
  // bench, but a customer selling the unit, or a household starting over, has
  // no shell — and "erase everything" is exactly the thing that must not
  // require one.
  //
  // Wi-Fi is kept unless explicitly forgotten. A reset that also drops the
  // network turns a five-minute redo into an unreachable panel, and the two
  // intentions ("start setup again" vs "I am selling this") are different
  // enough to be different buttons.
  // One call behind the Settings screen. Each card needs a line saying what it
  // is set to right now — a settings list that only shows names makes you open
  // every card to find the one that is wrong, which is the whole reason the
  // old wizard-from-the-top felt like a punishment.
  app.get('/api/setup/summary', async () => {
    const wifi = await wifiStatus()
    const online = cachedOnline()
    const sound = config.alerts?.sound ?? {}
    let photos = 0
    try {
      photos = fs.readdirSync(path.join(path.dirname(config.db), 'photos'))
        .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).length
    } catch { /* no photo dir yet */ }
    return {
      wifi: { ssid: wifi.ssid, online },
      location: config.weather?.label
        ?? (config.weather?.latitude != null
          ? `${Number(config.weather.latitude).toFixed(2)}, ${Number(config.weather.longitude).toFixed(2)}`
          : null),
      tankName: config.tankName ?? null,
      apex: config.apex?.host || null,
      equipment: {
        enabled: config.redSea?.enabled !== false,
        hidden: (config.redSea?.exclude ?? []).length,
        manual: (config.redSea?.hosts ?? []).length,
        seen: (state.redsea?.devices ?? []).length
      },
      alarms: {
        enabled: sound.enabled !== false,
        urgentTone: sound.urgentTone ?? 'siren',
        warningTone: sound.warningTone ?? 'alert'
      },
      slideshow: config.slideshow?.source ?? 'intro',
      support: state.support ?? { active: false },
      slideshowIdle: [2, 5, 10, 30, 60, 0].includes(Number(config.slideshow?.idleMinutes)) ? Number(config.slideshow.idleMinutes) : 5,
      dosingMethod: DOSING_METHODS[methodFor(config)].name,
      photos
    }
  })

  app.post('/api/setup/reset', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'A reset can only be started on the terminal itself.' })
    }
    const { confirm, forgetWifi } = req.body ?? {}
    if (confirm !== 'ERASE') return reply.code(400).send({ error: 'confirmation required' })
    if (DEMO) return { ok: true, demo: true }

    try { fs.rmSync(config.configPath, { force: true }) } catch { /* already gone */ }
    // Readings, photos, the log, silences — everything the household put
    // in. The db file is open right now; unlinking it is fine, and this
    // process is about to exit anyway.
    try { fs.rmSync(path.dirname(config.db), { recursive: true, force: true }) } catch { /* ditto */ }

    if (forgetWifi) {
      try {
        const out = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show'])
        for (const row of out.split('\n').map(splitFields)) {
          if (row[1] === '802-11-wireless') {
            try { await nmcli(['connection', 'delete', row[0]]) } catch { /* keep going */ }
          }
        }
      } catch { /* NetworkManager unavailable: the rest of the reset still stands */ }
    }

    // systemd restarts us; with no config.json the wizard runs from step one.
    setTimeout(() => process.exit(0), 800)
    return { ok: true, restarting: true }
  })

  app.post('/api/setup/complete', async (req, reply) => {
    const answers = req.body ?? {}
    const basePath = fs.existsSync(config.configPath) ? config.configPath : config.examplePath
    const next = JSON.parse(fs.readFileSync(basePath, 'utf8'))

    if (typeof answers.tankName === 'string') {
      const name = answers.tankName.trim().slice(0, 40)
      if (name) next.tankName = name
    }
    if (answers.location) {
      next.weather = { ...next.weather, latitude: answers.location.latitude, longitude: answers.location.longitude, label: answers.location.label ?? next.weather?.label }
    }
    if (answers.apex) {
      next.apex = {
        ...next.apex,
        host: answers.apex.host,
        username: answers.apex.username ?? 'admin',
        password: answers.apex.password ?? '1234',
        inputs: { ...next.apex.inputs, ...answers.apex.inputs }
      }
    }
    // Red Sea equipment. Only touched when the wizard's Equipment step was
    // actually used, so re-running setup and skipping it keeps what's there.
    if (answers.redSea) {
      next.redSea = {
        ...next.redSea,
        enabled: answers.redSea.enabled !== false,
        // Identity, not addresses: which units to hide, what to call them,
        // and any address typed in for a unit on another subnet. Discovery
        // is always on; the old `devices` pin is dropped if it is there.
        exclude: answers.redSea.exclude ?? [],
        hosts: answers.redSea.hosts ?? [],
        names: answers.redSea.names ?? {}
      }
      delete next.redSea.devices
    }
    // Every unit gets its own API token the first time setup completes. Units
    // used to ship with this empty, which left the API open to anything on the
    // customer's LAN — and a shared default would be worse than none at all.
    // The kiosk itself is localhost-exempt, so this is invisible on the wall.
    if (!next.apiToken) next.apiToken = crypto.randomBytes(16).toString('hex')

    next.setupComplete = true

    if (DEMO) return { ok: true, demo: true, config: next }

    fs.writeFileSync(config.configPath, JSON.stringify(next, null, 2))
    // systemd (Restart=always) brings the server back up with the new config
    setTimeout(() => process.exit(0), 800)
    return { ok: true, restarting: true }
  })
}
