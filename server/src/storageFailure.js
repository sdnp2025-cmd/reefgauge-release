import Fastify from 'fastify'

// What to do when the terminal cannot open its own storage.
//
// initDb() creates the data directory and opens the database at import time,
// unguarded. If that throws - a full card, a corrupt filesystem, a permissions
// change, or (soon) a /data partition that has not mounted yet - the process
// dies before app.listen(). systemd's Restart=always then loops it, and what
// the customer sees is a black screen for ever, with nothing on it saying why.
//
// A blank screen is the one failure that explains nothing: it looks identical
// to a dead panel, a dead Pi and a dead supply. index.js already refuses to let
// a damaged dashboard do that, and serves a page instead. This is the same
// argument one layer lower.
//
// The message deliberately says the OPPOSITE of the damaged-dashboard page.
// There, the tank genuinely is still being watched - readings are recorded and
// the alarms still sound, and saying so is a kindness. Here nothing is being
// recorded and no alarm will fire, and saying otherwise would be a lie told to
// somebody whose tank is unmonitored.

export async function serveStorageFailure(config, err) {
  const port = config.port ?? 8080
  const detail = String(err?.message ?? err)

  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReefGauge</title><style>
 html,body{margin:0;height:100%;background:#4a1113;color:#fdeaea;
   font:16px/1.55 -apple-system,system-ui,sans-serif;display:grid;place-items:center}
 main{max-width:640px;padding:32px;text-align:center}
 h1{font-size:30px;margin:0 0 14px}
 p{opacity:.9;margin:0 0 12px}
 code{background:rgba(255,255,255,.12);padding:2px 7px;border-radius:5px;font-size:15px}
 .warn{margin:22px 0;padding:14px;border-radius:10px;background:rgba(255,255,255,.14);
   font-weight:700}
 .why{font-size:14px;opacity:.75;margin-top:22px;word-break:break-word}
</style></head><body><main>
 <h1>This terminal cannot save anything</h1>
 <p>It could not open its storage, so it has not started.</p>
 <div class="warn">Your tank is NOT being watched. No readings are being
  recorded and no alarm will sound. Check it yourself until this is fixed.</div>
 <p>This is usually a full or failing SD card.</p>
 <p>If you have support, this is worth a call now.</p>
 <p class="why">${detail.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</p>
</main></body></html>`

  const app = Fastify({ logger: { level: 'warn' } })
  app.get('/api/health', async (req, reply) =>
    reply.code(503).send({ ok: false, error: 'storage unavailable', detail }))
  app.setNotFoundHandler(async (req, reply) => (
    req.url.startsWith('/api/')
      ? reply.code(503).send({ error: 'storage unavailable', detail })
      : reply.type('text/html').send(page)))
  app.get('/', async (req, reply) => reply.type('text/html').send(page))

  await app.listen({ port, host: '0.0.0.0' })
  console.error(`ReefGauge STORAGE FAILURE — serving the explanation on :${port}`)
  console.error(`  ${detail}`)

  // Hold the process here. Returning would let index.js carry on into the code
  // that needs the database it has just failed to open, and crash - which is
  // the restart loop this exists to replace.
  await new Promise(() => {})
}
