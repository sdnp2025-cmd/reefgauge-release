import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import { loadConfig } from './config.js'
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
import careRoutes from './routes/care.js'
import systemRoutes from './routes/system.js'
import { createSupportSession } from './supportSession.js'
import { seedDemo } from './demo.js'
import { authorize as authorizePhone } from './phoneSession.js'

const config = loadConfig()
const db = initDb(config.db)

const state = {
  tank: { latest: {}, inputs: [], updatedAt: null, error: null },
  environment: null,
  weather: null,
  ring: { camera: null, lastDing: null, snapshotAt: null, error: null },
}

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
await app.register(setupRoutes, { config, state })
await app.register(reefLogRoutes, { config, db })
await app.register(coralRoutes, { config, db })
await app.register(careRoutes, { config, state, db })
// Remote support: dialled out from here when the customer asks, never in.
const support = createSupportSession({ config, state, log: app.log })
await app.register(systemRoutes, { config, state, db, support })

// Uploaded family photos
const photosDir = path.join(path.dirname(config.db), 'photos')
fs.mkdirSync(photosDir, { recursive: true })
await app.register(fastifyStatic, { root: photosDir, prefix: '/photos/', decorateReply: false })

// Coral journal photos, kept apart from the slideshow: these are records of a
// particular animal on a particular day, not pictures to shuffle on the wall.
const coralDir = path.join(path.dirname(config.db), 'corals')
fs.mkdirSync(coralDir, { recursive: true })
await app.register(fastifyStatic, { root: coralDir, prefix: '/coral-photos/', decorateReply: false })

// Serve the built dashboard when web/dist exists (production on the Pi).
const webDist = path.resolve(config.serverRoot, '../web/dist')
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
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
console.log(`ReefGauge server listening on http://0.0.0.0:${config.port ?? 8080}`)
