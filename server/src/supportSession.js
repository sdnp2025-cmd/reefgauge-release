// A support session, from the terminal's side.
//
// The customer taps "Get support". This opens an outbound WebSocket to the
// relay, gets a six-digit code back, and shows it on screen. Whoever has the
// code — read out over the phone — can then ask this terminal a limited set
// of questions until the hour is up or the customer taps "End".
//
// Three properties worth defending, because they are the whole reason this
// design was chosen over an always-on tunnel:
//
//   Nothing opens without the customer. There is no way in from outside; the
//   socket is dialled from here, by a tap on the glass.
//
//   The allowlist lives HERE. The relay forwards {method, path} envelopes and
//   this file decides what it is willing to answer. Compromising the relay
//   does not widen the surface, and neither does a leaked operator key.
//
//   It closes itself. An hour, or the customer's tap, or a lost socket. A
//   session that has to be remembered to be revoked will be forgotten.
//
// What support can reach is the unit's health, not the customer's tank: the
// diagnostics, the logs, the service restarts, the version. Not the photos,
// not the coral journal, not the chemistry history.

// Reading and acting on the terminal. Writes are listed separately below,
// because they are the ones the customer is told about afterwards.
const ALLOW = [
  ['GET', /^\/api\/system\/diagnostics$/],
  ['GET', /^\/api\/system\/support-bundle$/],
  ['GET', /^\/api\/system\/logs(\?.*)?$/],
  ['GET', /^\/api\/system\/version$/],
  ['GET', /^\/api\/system\/update\/check$/],
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/setup\/status$/],
  ['GET', /^\/api\/setup\/summary$/],
  ['POST', /^\/api\/system\/restart\/(server|sensor|display)$/],
  ['POST', /^\/api\/system\/update$/],
  ['POST', /^\/api\/system\/reboot$/],

  // Settings. Most support calls are not a bug in the software - they are an
  // Apex input mapped to the wrong parameter, a range set somewhere the tank
  // will never sit, a screensaver nobody meant to turn off. Being able to see
  // that and not fix it means talking a customer through Settings over the
  // phone while they hold the handset against a wall panel.
  //
  // These are the existing, validated endpoints the terminal's own screens
  // use. Nothing here is a raw write to config.json: each one still bounds and
  // checks what it is given exactly as it does for a tap on the glass.
  ['POST', /^\/api\/setup\/complete$/],        // tank name, Apex, ranges, equipment
  ['POST', /^\/api\/alerts\/sounds$/],          // tones, quiet hours
  ['POST', /^\/api\/slideshow\/config$/],       // screensaver and its timer
  ['POST', /^\/api\/environment\/calibrate$/],  // room-air temperature offset
  ['GET',  /^\/api\/ranges$/],
  ['POST', /^\/api\/ranges$/],                 // the thresholds every alarm uses

  // Probes. These change nothing and are how you find out why an Apex is not
  // answering or which Red Sea units are actually on the network.
  ['POST', /^\/api\/setup\/apex\/(scan|verify)$/],
  ['POST', /^\/api\/setup\/redsea\/(scan|probe)$/]

  // Deliberately absent:
  //   /api/setup/reset        - wipes the unit. Never from a support session.
  //   /api/setup/wifi/connect - a wrong password takes the terminal off the
  //                             network mid-call, and nothing can put it back.
  //                             That is a conversation, not a remote action.
  //   /api/photos, /api/corals, /api/log/* - the customer's own data, which
  //                             the support panel promises is not visible.
]

// Writes get recorded. The customer is told what was changed, and "it stopped
// working after support touched it" becomes a question with an answer.
const WRITES = /^\/api\/(setup\/complete|alerts\/sounds|slideshow\/config|environment\/calibrate|ranges)$/
const AUDIT_MAX = 100

const allowed = (method, path) => ALLOW.some(([m, re]) => m === method && re.test(path))

const RECONNECT_MS = 5000
const MAX_MS = 60 * 60 * 1000

export function createSupportSession({ config, state, log = console }) {
  state.support = { active: false, code: null, expiresAt: null, operatorPresent: false, error: null, changes: [] }

  let ws = null
  let timer = null
  let closing = false

  // Survives the session it happened in, deliberately. "It has been wrong
  // since someone from support looked at it" is a thing customers say weeks
  // later, and an empty list is not an answer to it.
  const changes = []
  // warn, not info: the server runs its logger at 'warn', so an info line here
  // is written to nowhere. These are the events someone asks about weeks later
  // - who connected, when, and what they touched - and a record that depends
  // on a log level nobody remembers setting is not a record.
  function record(entry) {
    changes.push(entry)
    if (changes.length > AUDIT_MAX) changes.shift()
    state.support.changes = changes
    log.warn?.(`support changed ${entry.path} [${entry.fields.join(', ')}] -> ${entry.status}`)
  }

  const relayUrl = () => (config.support?.relay ?? 'wss://relay.reefgauge.com').replace(/\/$/, '')
  const port = config.port ?? 8080

  function reset(error = null) {
    clearTimeout(timer)
    timer = null
    state.support = { active: false, code: null, expiresAt: null, operatorPresent: false, error, changes }
  }

  async function handleRequest(msg) {
    const { id, method = 'GET', path, body } = msg
    const reply = (status, body) => {
      try { ws?.send(JSON.stringify({ type: 'response', id, status, body })) } catch { /* socket gone */ }
    }
    if (typeof path !== 'string' || !allowed(method, path)) {
      log.warn?.(`support: refused ${method} ${path}`)
      return reply(403, { error: 'that is not available during a support session' })
    }
    try {
      // Straight back into our own API over loopback, with this unit's token.
      // Going through HTTP rather than calling the route functions keeps the
      // support surface identical to the one the tool uses on the LAN.
      const json = body !== undefined && body !== null ? JSON.stringify(body) : null
      // 256 KB is far more than any setting needs and far less than anything
      // worth streaming. A support session is not a file upload.
      if (json && json.length > 256 * 1024) {
        return reply(413, { error: 'that is too large to send through a support session' })
      }
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
          ...(json ? { 'content-type': 'application/json' } : {})
        },
        body: json,
        signal: AbortSignal.timeout(45000)
      })
      const text = await res.text()
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 100000) } }
      // What changed, not what it changed to. A new Apex password would be in
      // that body, and an audit trail the customer can read is not the place
      // for it - the point is that something was touched, and what.
      if (WRITES.test(path)) {
        record({
          at: Date.now(),
          path,
          fields: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [],
          status: res.status
        })
      }
      reply(res.status, parsed)
    } catch (err) {
      reply(502, { error: `the terminal could not answer: ${err.message}` })
    }
  }

  function connect() {
    const url = `${relayUrl()}/terminal`
    try {
      // Same constraint as the support tool: Node's WebSocket has no way to
      // set a request header, so an enrol key travels as the subprotocol.
      ws = new WebSocket(url, config.support?.enrollKey
        ? ['reefgauge-terminal', config.support.enrollKey]
        : undefined)
    } catch (err) {
      reset(`could not reach the support relay: ${err.message}`)
      return
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        unit: {
          tankName: config.tankName ?? null,
          version: state.version ?? null,
          hostname: process.env.HOSTNAME ?? null
        }
      }))
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()) } catch { return }
      switch (msg.type) {
        case 'registered':
          state.support = {
            active: true,
            code: msg.code,
            expiresAt: Math.min(msg.expiresAt ?? Infinity, Date.now() + MAX_MS),
            operatorPresent: false,
            error: null,
            changes
          }
          log.warn?.(`support session open, code ${msg.code}`)
          // Belt and braces: the relay expires it too, but a terminal that
          // trusts the other end to close the door is not closed.
          timer = setTimeout(() => end('the hour is up'), state.support.expiresAt - Date.now())
          break
        case 'operator-joined':
          state.support.operatorPresent = true
          log.warn?.('support: an operator joined the session')
          break
        case 'operator-left':
          state.support.operatorPresent = false
          break
        case 'request':
          handleRequest(msg)
          break
        case 'closed':
          reset(msg.reason ?? null)
          break
        default:
          break
      }
    })

    ws.addEventListener('close', () => {
      if (closing) return reset()
      // Dropped before the customer ended it: try once more, then give up
      // rather than hammering a relay that may be down.
      if (state.support.active) {
        log.warn?.('support: relay connection lost, retrying once')
        state.support.active = false
        setTimeout(() => { if (!closing) connect() }, RECONNECT_MS)
      }
    })

    ws.addEventListener('error', () => { /* close follows */ })
  }

  function start() {
    if (state.support.active) return state.support
    closing = false
    reset()
    connect()
    return state.support
  }

  function end(why = 'ended by the customer') {
    closing = true
    clearTimeout(timer)
    try { ws?.close() } catch { /* already gone */ }
    ws = null
    reset()
    log.warn?.(`support session ${why}`)
    return state.support
  }

  return { start, end, status: () => state.support }
}
