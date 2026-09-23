// Short-lived sessions that let a phone on the customer's LAN reach a few
// specific endpoints — adding slideshow photos, lab results, coral photos.
//
// The only way to get one is to read a QR code rendered on the terminal's own
// screen, so holding a nonce means "somebody was standing in front of the
// display". That is the same bar the original phone hand-off used, widened
// to photos and given three things it lacked: an explicit scope, a hard
// expiry, and a binding to the first device that uses it.
//
// Minting happens on the terminal itself (localhost) only. Anything reachable
// from the LAN can validate a nonce but never create one.

import crypto from 'node:crypto'

export const SESSION_TTL_MS = 30 * 60 * 1000
// A fresh QR shouldn't leave a trail of still-usable codes behind it.
const MAX_SESSIONS = 8

const sessions = new Map()

export const isLocalRequest = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)

export function prune() {
  const now = Date.now()
  for (const [nonce, session] of sessions) {
    if (session.expires <= now) sessions.delete(nonce)
  }
}

export function mintSession(scopes) {
  prune()
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
  const nonce = crypto.randomBytes(12).toString('base64url')
  sessions.set(nonce, {
    scopes: [...new Set(scopes)],
    expires: Date.now() + SESSION_TTL_MS,
    boundIp: null
  })
  return { nonce, expiresAt: Date.now() + SESSION_TTL_MS }
}

// The nonce travels in a header on every phone request. The query string is
// accepted too (an <img>/<a> can't set headers), and the body, which the
// first phone form posted it in before sessions existed.
export function nonceFrom(req) {
  const header = req.headers?.['x-reef-session']
  if (typeof header === 'string' && header) return header
  const query = req.query?.rt
  if (typeof query === 'string' && query) return query
  const body = req.body?.nonce
  return typeof body === 'string' && body ? body : null
}

// Returns the session when it is live, carries `scope` (pass null for "any
// valid session"), and belongs to this device — otherwise null.
export function sessionFor(req, scope) {
  prune()
  const nonce = nonceFrom(req)
  if (!nonce) return null
  const session = sessions.get(nonce)
  if (!session) return null
  if (scope && !session.scopes.includes(scope)) return null
  // First phone to use a code owns it for the rest of its life, so a nonce
  // that leaks off the screen (a photo of the display, a shoulder surfer on
  // the far side of the room) is already spent by the time it is tried.
  if (session.boundIp == null) session.boundIp = req.ip
  else if (session.boundIp !== req.ip) return null
  return session
}

// The terminal's own touchscreen is always trusted; a phone needs a session.
export function authorize(req, scope) {
  return isLocalRequest(req) || Boolean(sessionFor(req, scope))
}
