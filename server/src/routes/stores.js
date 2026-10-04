import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'

// Nearby fish stores: the reef shops around the tank, with hours and a phone
// number, and a code the customer scans to get directions on their phone.
//
// The terminal does not hold a maps key. It asks the relay (relay/server.mjs,
// /places), which asks Google Places once per neighbourhood per week and
// remembers the answer. Here the list is kept for a week too, on /data, so a
// terminal that is offline for a while still has it - the stores do not move.

const TTL_MS = 7 * 24 * 3600_000

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

// Open right now, from Google's weekly periods. Done here rather than trusting
// a cached "openNow": the list may be days old.
export function openNow(periods, now = new Date()) {
  if (!Array.isArray(periods) || periods.length === 0) return null
  const day = now.getDay(), minutes = now.getHours() * 60 + now.getMinutes()
  for (const p of periods) {
    if (!p.open) continue
    if (!p.close) return true                                   // open 24 hours
    const start = p.open.hour * 60 + (p.open.minute ?? 0)
    const end = p.close.hour * 60 + (p.close.minute ?? 0)
    if (p.open.day === p.close.day) {
      if (p.open.day === day && minutes >= start && minutes < end) return true
    } else {
      // Closes after midnight.
      if (p.open.day === day && minutes >= start) return true
      if (p.close.day === day && minutes < end) return true
    }
  }
  return false
}

export default async function storesRoutes(app, { config }) {
  const file = path.join(path.dirname(config.db), 'stores.json')
  const relay = () => (config.support?.relay ?? 'wss://relay.reefgauge.com').replace(/^ws/, 'http').replace(/\/$/, '')

  const here = () => {
    const lat = Number(config.weather?.latitude), lon = Number(config.weather?.longitude)
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
  }

  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

  async function lookup(loc) {
    const res = await fetch(`${relay()}/places?lat=${loc.lat}&lon=${loc.lon}`, { signal: AbortSignal.timeout(20000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `the relay answered ${res.status}`)
    const saved = { at: Date.now(), lat: loc.lat, lon: loc.lon, stores: data.stores ?? [] }
    try { fs.writeFileSync(file, JSON.stringify(saved)) } catch { /* memory only */ }
    return saved
  }

  app.get('/api/stores', async (req) => {
    const loc = here()
    if (!loc) return { stores: [], error: 'The tank has no location yet. Set it in Settings → Location.' }
    let saved = read()
    const stale = !saved || Date.now() - saved.at > TTL_MS
      || distanceKm(saved.lat, saved.lon, loc.lat, loc.lon) > 2
    let error = null
    if (stale || req.query.refresh) {
      try { saved = await lookup(loc) } catch (err) { error = err.message; if (!saved) saved = { at: null, stores: [] } }
    }
    const stores = saved.stores
      .map((s) => ({
        ...s,
        km: s.lat != null ? distanceKm(loc.lat, loc.lon, s.lat, s.lon) : null,
        open: openNow(s.periods),
        periods: undefined
      }))
      .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9))
    return { stores, at: saved.at, error }
  })

  // Directions on the phone: a code for the store's Google Maps page. Only for
  // a store in the list, never for an arbitrary address.
  app.get('/api/stores/:id/qr.svg', async (req, reply) => {
    const store = (read()?.stores ?? []).find((s) => s.id === req.params.id)
    if (!store?.maps) return reply.code(404).send({ error: 'no such store' })
    reply.type('image/svg+xml')
    return QRCode.toString(store.maps, { type: 'svg', margin: 1 })
  })
}
