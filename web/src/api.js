import { useEffect, useState } from 'react'

// A phone that scanned the QR on the terminal arrives at /?rt=<nonce>. Hold on
// to it for the life of the tab so uploads keep working after the query string
// is tidied out of the address bar.
let phoneSession = null
try {
  const fromUrl = new URLSearchParams(location.search).get('rt')
  if (fromUrl) sessionStorage.setItem('rt_session', fromUrl)
  phoneSession = sessionStorage.getItem('rt_session')
} catch {
  phoneSession = new URLSearchParams(location.search).get('rt')
}

export function sessionNonce() {
  return phoneSession
}

export function authHeaders() {
  const headers = {}
  if (phoneSession) headers['x-reef-session'] = phoneSession
  try {
    const token = localStorage.getItem('rt_token')
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // private-mode Safari; the session header is enough for the phone page
  }
  return headers
}

// Saving a setting restarts the server (systemd brings it straight back), and
// the page that reloads into the gap gets a failed fetch for everything it
// asks. That is how a settings list ends up saying "Not connected" about a
// network it is talking over: the answer never arrived, and "no answer" was
// drawn as "not set up".
//
// So: wait for the service to actually answer before reloading.
export async function waitForServer({ timeoutMs = 30000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.ok) return true
    } catch { /* still down — that is the expected case here */ }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

// Wait for the server to report setup complete, not merely to answer.
//
// waitForServer returns on the first 200 from /api/health, and after
// /api/setup/complete the OLD process is still alive for 800ms - long enough to
// answer that poll. The page then reloaded against the outgoing server, which
// still said setupComplete: false, and the customer landed back on the welcome
// screen having just finished the wizard. Nothing reloaded again, so it stayed
// there, which reads as a setup loop.
//
// The state we are waiting for is the state to poll for.
export async function waitForSetupComplete({ timeoutMs = 60000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/setup/status', { cache: 'no-store' })
      if (res.ok && (await res.json())?.complete) return true
    } catch { /* restarting - expected */ }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

// The mirror image, for a factory reset: wait for a server that says the unit
// is NOT set up. The first second is skipped outright - the process that took
// the reset is still answering for 800ms, and the one worth asking is the one
// systemd starts after it.
export async function waitForSetupReset({ timeoutMs = 60000, pollMs = 400 } = {}) {
  await new Promise((r) => setTimeout(r, 1500))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/setup/status', { cache: 'no-store' })
      if (res.ok && (await res.json())?.complete === false) return true
    } catch { /* restarting - expected */ }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

export async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers ?? {}) } })
  if (!res.ok) {
    // Surface the server's own wording ("scan the code again…") when it has any.
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* not JSON */ }
    const err = new Error(detail || `${path}: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Fetch `path` on mount and every `intervalMs`. Returns [data, refetch].
// A null path polls nothing — for panels that shouldn't be calling home at all
// (the phone hand-off page has no token and would just collect 401s).
export function usePolling(path, intervalMs) {
  const [data, setData] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const load = () => api(path).then((d) => { if (!cancelled) setData(d) }).catch(() => {})
    load()
    const id = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [path, intervalMs, tick])

  return [data, () => setTick((t) => t + 1)]
}

const WEATHER_CODES = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Storm w/ hail', '⛈️'], 99: ['Storm w/ hail', '⛈️']
}

export function weatherLabel(code) {
  return WEATHER_CODES[code] ?? ['—', '❔']
}
