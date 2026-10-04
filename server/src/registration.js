// Customer registration: who owns this terminal.
//
// The wizard collects a name, an email address and a phone number, and the
// screen that asks for them promises they are kept confidential. Two things
// follow from that promise and both live here:
//
//   One validator. The wizard, a support session and anything else that posts
//   to /api/setup/complete go through validateRegistration(), so what is stored
//   is bounded and shaped whoever sent it.
//
//   One destination. The registration goes to ReefGauge's own server, over
//   TLS, and nowhere else. It is deliberately NOT in the support bundle or the
//   diagnostics (see routes/system.js) - a support call is about the unit's
//   health and has no need of the owner's phone number.
//
// Delivery is retried rather than attempted once: setup is often finished
// before the Wi-Fi has settled, and a registration that is silently lost at
// that moment is lost for good.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Returns { value } or { error } - the error is written for the customer. */
export function validateRegistration(input) {
  const firstName = clean(input?.firstName, 60)
  const lastName = clean(input?.lastName, 60)
  const email = clean(input?.email, 120)
  const phone = clean(input?.phone, 30)
  if (!firstName) return { error: 'Please enter your first name.' }
  if (!lastName) return { error: 'Please enter your last name.' }
  if (!EMAIL.test(email)) return { error: 'That email address does not look right - check it and try again.' }
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return { error: 'Please enter a phone number with its area code.' }
  return { value: { firstName, lastName, email, phone } }
}

// Stable per unit, and not the API token itself. The Pi's serial survives a
// re-image; a development machine has none and falls back to the token's hash.
function unitId(config) {
  try {
    const m = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^Serial\s*:\s*([0-9a-f]+)$/mi)
    if (m && !/^0+$/.test(m[1])) return m[1]
  } catch { /* not a Pi */ }
  return crypto.createHash('sha256').update(String(config.apiToken ?? '')).digest('hex').slice(0, 16)
}

// The serial number the Command Center wrote onto the card when it was flashed
// (tools/card-writer/write_helper.py). It is how a registration is matched to
// the card that was made for it; a card flashed any other way has none.
export function cardSerial() {
  for (const file of ['/boot/firmware/reefgauge-serial', '/boot/reefgauge-serial']) {
    try {
      const s = fs.readFileSync(file, 'utf8').trim()
      if (/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(s)) return s
    } catch { /* not stamped */ }
  }
  return null
}

function endpoint(config) {
  if (config.registrationUrl) return config.registrationUrl
  const relay = config.support?.relay
  if (!relay) return null
  return `${relay.replace(/^ws/, 'http').replace(/\/$/, '')}/register`
}

function version(config) {
  try { return fs.readFileSync(path.resolve(config.serverRoot, '../VERSION'), 'utf8').trim() } catch { return null }
}

export function startRegistrationDelivery({ config, log }) {
  if (process.env.DEMO) return
  const url = endpoint(config)
  const marker = path.join(path.dirname(config.db), '.registration-sent')

  const attempt = async () => {
    const reg = config.registration
    if (!reg || !url) return
    const body = {
      unitId: unitId(config),
      serial: cardSerial(),
      firstName: reg.firstName,
      lastName: reg.lastName,
      email: reg.email,
      phone: reg.phone,
      tankName: config.tankName ?? null,
      registeredAt: reg.registeredAt ?? null
    }
    // The marker holds a hash of what was last accepted, so an edit made in
    // Settings is sent again and an unchanged registration never is.
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
    try { if (fs.readFileSync(marker, 'utf8').trim() === hash) return } catch { /* never sent */ }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, version: version(config) }),
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) throw new Error(`the registration server answered ${res.status}`)
      fs.writeFileSync(marker, hash)
      log.info?.('registration delivered')
    } catch (err) {
      // No personal details in the log: it is readable in a support session.
      log.warn?.(`registration not delivered yet, will retry: ${err.message}`)
    }
  }

  setTimeout(attempt, 20_000).unref()
  setInterval(attempt, 10 * 60_000).unref()
}
