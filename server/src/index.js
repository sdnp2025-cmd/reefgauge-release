import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import { loadConfig } from './config.js'
import { serveStorageFailure } from './storageFailure.js'
import { startClockWatch, onClockStep, shift } from './clock.js'
import { initDb, pruneOldReadings } from './db.js'
import { startApexPoller } from './pollers/apex.js'
import { startWeatherPoller } from './pollers/weather.js'
import { startRingListener } from './pollers/ring.js'
import { startRedSeaPoller } from './pollers/redsea.js'
import { startAlerts } from './alerts.js'
import apiRoutes from './routes/api.js'
import setupRoutes from './routes/setup.js'
import reefLogRoutes from './routes/reeflog.js'
import coralRoutes from './routes/corals.js'
import storesRoutes from './routes/stores.js'
import careRoutes from './routes/care.js'
import systemRoutes from './routes/system.js'
import { createSupportSession } from './supportSession.js'
import { startRegistrationDelivery } from './registration.js'
import { seedDemo } from './demo.js'
import { authorize as authorizePhone } from './phoneSession.js'

const config = loadConfig()

// Opening the database is the first thing that can fail, and it used to fail
// fatally: initDb creates the data directory and opens the file, unguarded, so
// a full card or an unwritable path killed the process before app.listen() and
// systemd looped it for ever behind a black screen. Say what happened instead.
let db
try {
  db = initDb(config.db)
} catch (err) {
  await serveStorageFailure(config, err)   // listens, and never returns
}

// Watch for the clock being stepped before anything starts recording times
// against it. See clock.js: this machine has no real-time clock, so it boots
// believing it is whenever it last was and is corrected by NTP seconds later.
startClockWatch(console)

const state = {
  tank: { latest: {}, inputs: [], updatedAt: null, error: null },
  environment: null,
  weather: null,
  ring: { camera: null, lastDing: null, snapshotAt: null, error: null },
  display: null,   // what the kiosk's browser reported it can draw; see diagnostics display()
}

// Everything else in `state` that is a wall-clock instant. Each of these is
// read as "how long ago", so each has to move with the clock or it starts
// lying by the size of the step - which for the environment timestamps means a
// CO2 sensor that reported thirty seconds ago being declared offline.
onClockStep((delta) => {
  if (state.environment) state.environment.ts = shift(state.environment.ts, delta)
  for (const reading of Object.values(state.env ?? {})) {
    if (reading) reading.ts = shift(reading.ts, delta)
  }
  if (state.ring) {
    state.ring.lastDing = shift(state.ring.lastDing, delta)
    state.ring.snapshotAt = shift(state.ring.snapshotAt, delta)
  }
})

const app = Fastify({ logger: { level: 'warn' }, trustProxy: false })
await app.register(fastifyCors, { origin: true })

// Per-unit API token (config.apiToken, generated when setup completes):
// protects /api/* from other devices on the customer's network. The kiosk
// itself (localhost), static assets, and /alexa (signature-verified
// separately) are exempt.
const LOCAL_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

// Setup used to be exempt wholesale, which meant anyone on the LAN could
// re-run the wizard — repoint the Wi-Fi, wipe the config.
// Only the endpoints the customer's phone genuinely needs stay reachable, and
// all but read-only status now require a phone session: a scoped, expiring
// nonce that only exists inside a QR code drawn on the terminal's screen.
// (Minting one used to be a LAN call itself, so any device on the network
// could ask for a nonce and hand itself the keys.)
const SETUP_READABLE_FROM_LAN = ['/api/setup/status']

// Which phone-session scope, if any, lets a request past without a token.
function phoneScopeFor(path, method) {
  if (path === '/api/setup/session') return 'any'
  if (path === '/api/photos' || path.startsWith('/api/photos/')) return 'photos'
  // Pasting or uploading a lab report is the one job that genuinely needs a
  // phone: the report is already on it, and it has a keyboard. Adding only —
  // the same scope on DELETE would let a scanned code wipe the tank's test
  // history, which is not what anyone thinks they are handing over.
  if (method === 'POST' && (path === '/api/log/icp' || path === '/api/log/icp/extract')) return 'icp'
  // The coral journal is photographed from a phone at the glass, so the phone
  // needs to read the list (to pick which coral), add one, and post photos to
  // it. Deleting stays on the terminal: a scanned code should never be able to
  // remove a colony's history.
  if (path === '/api/corals' && (method === 'GET' || method === 'POST')) return 'corals'
  if (method === 'POST' && /^\/api\/corals\/\d+\/photos$/.test(path)) return 'corals'
  return null
}

// Nothing this API returns is cacheable: every reading, event and alert is
// "what is true right now", and the whole point of the panel is that the wall
// agrees with the tank. Fastify sends no cache headers of its own, and a
// response with neither Cache-Control nor a validator is one the browser is
// free to reuse — which once left a card stale for hours after its source
// had recovered, and a reload fixed what no amount of waiting would.
app.addHook('onSend', async (req, reply, payload) => {
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  return payload
})

app.addHook('onRequest', async (req, reply) => {
  const token = config.apiToken
  if (!req.url.startsWith('/api/')) return
  if (LOCAL_IPS.includes(req.ip)) return

  // Fail closed. An empty token used to skip this hook entirely, which meant
  // "no token configured" silently equalled "no authentication at all" for
  // every device on the customer's network. loadConfig now always mints one,
  // so an empty value here means something is wrong — deny rather than open up.
  if (!token) {
    return reply.code(503).send({ error: 'this terminal has no API token configured' })
  }

  const path = req.url.split('?')[0]

  // A phone that scanned the QR gets exactly the endpoints that hand-off needs.
  const scope = phoneScopeFor(path, req.method)
  if (scope && authorizePhone(req, scope === 'any' ? null : scope)) return

  if (path.startsWith('/api/setup/')) {
    if (SETUP_READABLE_FROM_LAN.includes(path)) return
    return reply.code(403).send({ error: 'setup is only available on the terminal itself' })
  }

  const supplied = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.query?.token
  if (supplied !== token) return reply.code(401).send({ error: 'unauthorized — token required' })
})
await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } })
await app.register(apiRoutes, { config, state, db })
await app.register(storesRoutes, { config })
await app.register(setupRoutes, { config, state })
await app.register(reefLogRoutes, { config, db })
await app.register(coralRoutes, { config, db })
await app.register(careRoutes, { config, state, db })
// Remote support: dialled out from here when the customer asks, never in.
const support = createSupportSession({ config, state, log: app.log })
await app.register(systemRoutes, { config, state, db, support })

// Uploaded family photos
const photosDir = path.join(path.dirname(config.db), 'photos')
// Non-fatal, deliberately: a terminal that cannot store family photographs is
// still a terminal that watches a tank, and the alarm matters more than the
// slideshow. The upload route fails on its own if this never appeared.
try { fs.mkdirSync(photosDir, { recursive: true }) } catch (err) {
  console.warn(`could not create the photo directory (${err.message}) - uploads will fail`)
}
await app.register(fastifyStatic, { root: photosDir, prefix: '/photos/', decorateReply: false })

// Coral journal photos, kept apart from the slideshow: these are records of a
// particular animal on a particular day, not pictures to shuffle on the wall.
const coralDir = path.join(path.dirname(config.db), 'corals')
try { fs.mkdirSync(coralDir, { recursive: true }) } catch (err) {
  console.warn(`could not create the coral directory (${err.message}) - uploads will fail`)
}
await app.register(fastifyStatic, { root: coralDir, prefix: '/coral-photos/', decorateReply: false })

// Serve the built dashboard when web/dist exists (production on the Pi).
//
// And check it is actually there. A build interrupted by a brownout leaves
// index.html and the bundle at zero bytes while exiting cleanly, and the kiosk
// then draws a white screen for as long as nobody notices - alarms sounding,
// tank unmonitored on screen, nothing anywhere saying why. A blank page is the
// one failure that explains nothing, so if the dashboard is not intact this
// serves a page that does.
const webDist = path.resolve(config.serverRoot, '../web/dist')

function dashboardBroken() {
  try {
    const html = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')
    if (!html.trim()) return 'the page is empty'
    const asset = html.match(/\/assets\/[^"']+\.js/)?.[0]
    if (!asset) return 'the page references no application code'
    const bundle = path.join(webDist, asset)
    if (!fs.existsSync(bundle)) return 'the application code is missing'
    if (fs.statSync(bundle).size < 10240) return 'the application code is truncated'
    return null
  } catch (err) {
    return err.message
  }
}

const broken = fs.existsSync(webDist) ? dashboardBroken() : 'it was never built'
if (fs.existsSync(webDist) && !broken) {
  await app.register(fastifyStatic, { root: webDist })
} else if (fs.existsSync(webDist)) {
  console.error(`web/dist is damaged (${broken}) — serving the recovery page instead`)
  // Deliberately one inline string with no assets: whatever went wrong took
  // the built files with it, so this cannot depend on any of them.
  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReefGauge</title><style>
 html,body{margin:0;height:100%;background:#0d2b3e;color:#eaf2f7;
   font:16px/1.55 -apple-system,system-ui,sans-serif;display:grid;place-items:center}
 main{max-width:620px;padding:32px;text-align:center}
 h1{font-size:30px;margin:0 0 14px}
 p{opacity:.85;margin:0 0 12px}
 code{background:rgba(255,255,255,.1);padding:2px 7px;border-radius:5px;font-size:15px}
 .ok{margin-top:22px;padding:14px;border-radius:10px;background:rgba(80,200,140,.16)}
</style></head><body><main>
 <h1>This screen needs repairing</h1>
 <p>The display software on this terminal is damaged — ${broken}.</p>
 <div class="ok"><b>Your tank is still being watched.</b> Readings are still being
  recorded and the alarms still sound. It is only this screen that is affected.</div>
 <p style="margin-top:22px">To repair it, run on the terminal:</p>
 <p><code>cd ~/reef-terminal/web &amp;&amp; npm run build</code></p>
 <p>then restart the display. If you have support, this is worth a call.</p>
</main></body></html>`
  app.get('/', async (req, reply) => reply.type('text/html').send(page))
  app.setNotFoundHandler(async (req, reply) => req.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'not found' })
    : reply.type('text/html').send(page))
} else {
  console.warn('web/dist not found — run `npm run build` in web/ (dev: use the Vite dev server).')
}

// Nothing may touch the customer's network until they have actually completed
// setup. An unconfigured unit previously polled the EXAMPLE addresses — logging
// into 192.168.1.50 with admin/1234 once a minute — which on a stranger's
// network means hammering somebody else's device with default credentials
// straight out of the box.
const configured = !config.isExample && config.setupComplete === true

if (process.env.DEMO) {
  console.log('DEMO mode: seeding fake tank/env data')
  seedDemo(state, db)
} else if (!configured) {
  console.log('Setup not complete — network pollers stay idle until the wizard finishes')
} else {
  startApexPoller(config, state, db)
  startRingListener(config, state, path.dirname(config.db))
  startRedSeaPoller(config, state, path.dirname(config.db))
}
startWeatherPoller(config, state)
startAlerts(config, state, db)

pruneOldReadings(db)
setInterval(() => pruneOldReadings(db), 24 * 3600 * 1000)

await app.listen({ port: config.port ?? 8080, host: '0.0.0.0' })

// An update asks for the display to be reloaded by leaving a marker beside the
// database (scripts/update.sh). It cannot do it itself: it is a child of the
// previous server process and dies with it. By the time this runs the new
// dashboard is on disk and this process is the one serving it, so the kiosk's
// own start-up wait finds a healthy server and loads the new bundle. The request
// goes through the existing restart route so the user-versus-system kiosk logic
// lives in one place; inject() arrives as localhost and is auth-exempt.
try {
  const reloadMarker = path.join(path.dirname(config.db), '.reload-display')
  if (fs.existsSync(reloadMarker)) {
    fs.rmSync(reloadMarker, { force: true })
    setTimeout(() => {
      app.inject({ method: 'POST', url: '/api/system/restart/display' }).catch(() => {})
    }, 3000)
  }
} catch { /* a reload is a courtesy; it must never stop the server starting */ }
startRegistrationDelivery({ config, log: app.log })
console.log(`ReefGauge server listening on http://0.0.0.0:${config.port ?? 8080}`)
