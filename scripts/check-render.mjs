#!/usr/bin/env node
// Does the dashboard actually render?
//
// The file checks in update.sh confirm a build produced something of a
// plausible size. They cannot tell whether it works. A bundle can be perfectly
// well-formed and throw on the first render - which is exactly what happened:
// JSX referencing a variable that was never destructured built cleanly, passed
// every size check, and took the wall display down. The kiosk froze on the last
// frame it had drawn, so it read as a stuck screensaver rather than a crash.
//
// So: load the page the way the kiosk does, and watch for two things.
//
//   Did it throw. An uncaught exception during render is a blank or frozen
//   screen, whatever the file sizes say.
//
//   Did it draw. A page that renders nothing while throwing nothing would pass
//   an error check and still be a blank screen, so the text has to be there
//   too.
//
// Usage:  node scripts/check-render.mjs [url]
// Exit:   0 rendered, 1 did not.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8080/'
// Not 9223: that is the port used by hand for screenshots, and a check that
// silently attaches to someone's debugging session proves nothing about this
// build.
const PORT = 9333
const SETTLE_MS = 9000
const MIN_TEXT = 60

const chromium = process.env.CHROMIUM ?? 'chromium'
const profile = mkdtempSync(join(tmpdir(), 'reefgauge-render-'))
let proc = null

const die = (ok, msg) => {
  try { proc?.kill('SIGKILL') } catch { /* already gone */ }
  // Chromium is still flushing its profile as it dies, so a delete here races
  // it and throws ENOTEMPTY. A temp directory left behind is worth nothing;
  // a failed cleanup masking the actual verdict is worth a great deal.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* it is /tmp */ }
  console.log(`    ${msg}`)
  process.exit(ok ? 0 : 1)
}

proc = spawn(chromium, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
  '--no-sandbox', '--no-first-run', '--disable-extensions',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore', detached: false })
proc.on('error', () => die(false, `could not start ${chromium} - is it installed?`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The whole check is bounded: an update must not be able to hang on a browser
// that never came up.
const guard = setTimeout(() => die(false, 'render check timed out'), 45000)

try {
  let targets = null
  for (let i = 0; i < 30 && !targets; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await res.json()
      if (list.length) targets = list
    } catch { /* not listening yet */ }
  }
  if (!targets) die(false, 'the headless browser never answered')

  const page = targets.find((t) => t.type === 'page') ?? targets[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const errors = []
  let id = 1
  const pending = new Map()

  const send = (method, params = {}) => new Promise((resolve) => {
    const n = id++
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('could not attach')))
  })

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push(d.exception?.description ?? d.text ?? 'unknown exception')
    }
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: URL_ })
  await sleep(SETTLE_MS)

  const drawn = await send('Runtime.evaluate', {
    expression: '(document.body && document.body.innerText || "").trim().length',
    returnByValue: true
  })
  const chars = drawn?.result?.value ?? 0

  if (errors.length) {
    console.log(`    the dashboard threw on load: ${errors[0].split('\n')[0]}`)
    die(false, `render check FAILED (${errors.length} uncaught error${errors.length === 1 ? '' : 's'})`)
  }
  if (chars < MIN_TEXT) {
    die(false, `render check FAILED - the page drew almost nothing (${chars} characters)`)
  }
  clearTimeout(guard)
  die(true, `dashboard renders (${chars} characters drawn, no errors)`)
} catch (err) {
  die(false, `render check could not run: ${err.message}`)
}
