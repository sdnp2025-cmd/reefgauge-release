import { usePolling } from './api.js'

// The room-air sensor is the one reading that can go away without anything
// else noticing: the Apex has its own alert, the Red Sea gear reports itself
// offline, but a dead SCD41 just stops inserting rows — and the card went on
// showing the last number it ever saw, in green, with "Good" beside it. A
// six-day-old 755 ppm looked exactly like a fresh one.
//
// Same threshold the server alerts on (alerts.js ENV_STALE_MS), so the card
// and the ticker say "no reading" at the same moment the alert is raised.
export const ENV_STALE_MS = 15 * 60 * 1000

function since(ms) {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

// One reading, and an honest answer about how old it is.
//   env      the payload, whatever its age
//   stale    true when it is too old to state as current (or absent)
//   never    true when the terminal has never had a reading at all
//   sinceText  "12 minutes ago" — null when the reading is current
export function useEnvironment(intervalMs = 30000) {
  const [env] = usePolling('/api/environment/latest', intervalMs)
  const ts = env?.ts ?? null
  const has = env?.co2_ppm != null || env?.temp_c != null
  const age = ts ? Date.now() - ts : null
  const stale = !has || age == null || age > ENV_STALE_MS
  return {
    env,
    stale,
    never: !has,
    ageMs: age,
    sinceText: stale && age != null ? since(age) : null,
    // A stale reading may not claim a status - it is not "Good", it is unknown.
    status: stale ? 'stale' : env?.co2Status === 'high' ? 'crit' : env?.co2Status === 'warn' ? 'warn' : 'ok'
  }
}
