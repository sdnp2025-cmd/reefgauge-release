// Everything a support session needs to know about a terminal, gathered in
// one pass and graded.
//
// The point is that a customer says "it's not working" and the answer comes
// from the unit rather than from twenty questions. Each check returns the same
// shape - id, label, status, value, detail, fix - so the support tool can
// print them, sort by severity, and show the fix without knowing what any
// particular check means.
//
//   ok       working, nothing to say
//   warn     working but heading somewhere bad, or degraded
//   fail     not working; this is why the customer called
//   unknown  could not be determined (not a failure - say so honestly)
//
// Every probe is best-effort and wrapped: a diagnostics endpoint that throws
// is useless precisely when it is needed. A probe that cannot run returns
// `unknown` and the rest still come back.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const run = async (cmd, args, timeout = 5000) => {
  try {
    const { stdout } = await exec(cmd, args, { timeout })
    return stdout.trim()
  } catch {
    return null
  }
}

const check = (id, label, status, value, detail, fix) => ({ id, label, status, value, detail: detail ?? null, fix: fix ?? null })
const ago = (ts) => {
  if (!ts) return null
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// ---- power ------------------------------------------------------------------
// The single most common field failure on a Pi, and the one that looks like
// everything else: a display that stutters, an SD card that corrupts, a unit
// that reboots on its own. vcgencmd is the truth; the CPU frequency is not
// (it reads normal while the firmware is capping it).
async function power() {
  const raw = await run('vcgencmd', ['get_throttled'])
  if (!raw) return [check('power', 'Power supply', 'unknown', null, 'vcgencmd unavailable')]
  const bits = parseInt(raw.split('=')[1], 16)
  const now = { under: !!(bits & 0x1), capped: !!(bits & 0x2), throttled: !!(bits & 0x4) }
  const ever = { under: !!(bits & 0x10000), capped: !!(bits & 0x20000), throttled: !!(bits & 0x40000) }
  const hex = `0x${bits.toString(16)}`
  if (now.under || now.throttled) {
    return [check('power', 'Power supply', 'fail', hex,
      `Under-voltage${now.throttled ? ' and throttling' : ''} RIGHT NOW. The CPU is being slowed to survive the supply.`,
      'Fit a 5 V 3 A USB-C supply (the official Raspberry Pi one). Do not power the panel from the Pi.')]
  }
  if (ever.under || ever.throttled) {
    return [check('power', 'Power supply', 'warn', hex,
      'Under-voltage has happened since boot, though not right now. Usually the boot-time surge or a marginal supply.',
      'If this keeps appearing, replace the supply or the USB-C cable.')]
  }
  return [check('power', 'Power supply', 'ok', hex, 'No under-voltage since boot')]
}

// ---- thermal ----------------------------------------------------------------
async function thermal() {
  const raw = await run('vcgencmd', ['measure_temp'])
  const c = raw ? Number(raw.replace(/[^\d.]/g, '')) : null
  if (c == null) return [check('temp', 'CPU temperature', 'unknown', null, 'vcgencmd unavailable')]
  const status = c >= 80 ? 'fail' : c >= 70 ? 'warn' : 'ok'
  return [check('temp', 'CPU temperature', status, `${c.toFixed(1)} °C`,
    status === 'ok' ? null : 'The Pi throttles itself at 80 °C.',
    status === 'ok' ? null : 'Check the case vents are clear and the fan is spinning.')]
}

// ---- storage and memory -----------------------------------------------------
async function storage(dataDir) {
  const out = []
  const df = await run('df', ['-Pk', '/'])
  if (df) {
    const [, size, used, , pct] = df.split('\n')[1].split(/\s+/)
    const freeGb = (Number(size) - Number(used)) / 1024 / 1024
    const usedPct = Number(String(pct).replace('%', ''))
    out.push(check('disk', 'Disk space', usedPct >= 92 ? 'fail' : usedPct >= 80 ? 'warn' : 'ok',
      `${freeGb.toFixed(1)} GB free (${usedPct}% used)`,
      usedPct >= 80 ? 'A full SD card corrupts on the next power cut.' : null,
      usedPct >= 80 ? 'Clear old photos and coral images, or re-image onto a larger card.' : null))
  } else out.push(check('disk', 'Disk space', 'unknown', null, 'df unavailable'))

  const totalMb = os.totalmem() / 1048576
  const freeMb = os.freemem() / 1048576
  out.push(check('memory', 'Memory', freeMb < 80 ? 'warn' : 'ok',
    `${Math.round(freeMb)} MB free of ${Math.round(totalMb)} MB`,
    freeMb < 80 ? 'Low free memory; the kiosk browser may be restarted by the kernel.' : null))

  // Read-only root is what an SD card does when it is dying.
  const mounts = await run('findmnt', ['-no', 'OPTIONS', '/'])
  if (mounts) {
    out.push(check('rootfs', 'Filesystem', mounts.split(',')[0] === 'ro' ? 'fail' : 'ok',
      mounts.split(',')[0],
      mounts.split(',')[0] === 'ro' ? 'The root filesystem has gone read-only - the SD card is failing or was pulled live.' : null,
      mounts.split(',')[0] === 'ro' ? 'Re-image onto a new card; this one is not trustworthy.' : null))
  }

  try {
    const db = path.join(dataDir, 'reef.db')
    const mb = fs.statSync(db).size / 1048576
    out.push(check('database', 'Database', mb > 400 ? 'warn' : 'ok', `${mb.toFixed(1)} MB`,
      mb > 400 ? 'Unusually large; history may never have been pruned.' : null))
  } catch {
    out.push(check('database', 'Database', 'fail', null, 'reef.db is missing', 'Restore from a backup or re-run setup.'))
  }
  return out
}

// ---- services ---------------------------------------------------------------
// The kiosk is a user unit, so it needs the user bus; the server and the
// sensor daemon are system units. A unit that is "activating (auto-restart)"
// is not starting up, it is crash-looping - the distinction matters more than
// any other single line in a support call.
async function services() {
  const out = []
  const system = [['reef-server.service', 'Terminal server'], ['co2-daemon.service', 'Room-air sensor daemon']]
  for (const [unit, label] of system) {
    const active = await run('systemctl', ['is-active', unit])
    const sub = await run('systemctl', ['show', unit, '-p', 'SubState', '--value'])
    const restarts = await run('systemctl', ['show', unit, '-p', 'NRestarts', '--value'])
    const crashing = sub === 'auto-restart' || (active === 'activating' && Number(restarts) > 3)
    out.push(check(`svc:${unit}`, label,
      active === 'active' ? 'ok' : crashing ? 'fail' : active ? 'warn' : 'unknown',
      active ?? 'unknown',
      crashing ? `Crash-looping (${restarts} restarts). It exits as soon as it starts.` : null,
      crashing ? `journalctl -u ${unit} -n 50 shows why.` : null))
  }
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` }
  let kiosk = null
  try {
    kiosk = (await exec('systemctl', ['--user', 'is-active', 'reef-kiosk.service'], { env, timeout: 5000 })).stdout.trim()
  } catch (err) {
    kiosk = err.stdout?.trim() || null
  }
  out.push(check('svc:kiosk', 'On-screen display',
    kiosk === 'active' ? 'ok' : kiosk ? 'fail' : 'unknown',
    kiosk ?? 'unknown',
    kiosk && kiosk !== 'active' ? 'The browser that draws the dashboard is not running - the screen is blank or frozen.' : null,
    kiosk && kiosk !== 'active' ? 'Restart it: systemctl --user restart reef-kiosk.service' : null))
  return out
}

// ---- network ----------------------------------------------------------------
async function network() {
  const out = []
  const nm = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'])
  const line = nm?.split('\n').find((l) => l.startsWith('yes:'))
  if (line) {
    const [, ssid, signal] = line.split(':')
    const s = Number(signal)
    out.push(check('wifi', 'Wi-Fi', s < 35 ? 'fail' : s < 50 ? 'warn' : 'ok', `${ssid} (${signal}%)`,
      s < 50 ? 'Weak signal. Drops and slow updates come from this long before the unit goes offline.' : null,
      s < 50 ? 'Move the router or add a mesh point nearer the tank.' : null))
  } else {
    const eth = Object.values(os.networkInterfaces()).flat().some((i) => i && !i.internal && i.family === 'IPv4')
    out.push(check('wifi', 'Wi-Fi', eth ? 'ok' : 'fail', eth ? 'wired or unknown' : 'not connected',
      eth ? 'No Wi-Fi association reported; the unit appears to be wired.' : 'No network connection.',
      eth ? null : 'Re-run Wi-Fi setup on the terminal.'))
  }
  const ip = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address)
  out.push(check('ip', 'Address', ip.length ? 'ok' : 'fail', ip.join(', ') || 'none'))

  // The internet is optional - weather and push need it, the tank does not.
  const ok = await run('curl', ['-sS', '-m', '6', '-o', '/dev/null', '-w', '%{http_code}', 'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m'], 8000)
  out.push(check('internet', 'Internet', ok === '200' ? 'ok' : 'warn', ok === '200' ? 'reachable' : 'unreachable',
    ok === '200' ? null : 'Weather, radar and phone alerts need the internet. The tank display does not.'))
  return out
}

// ---- integrations -----------------------------------------------------------
function integrations(state, config, db) {
  const out = []
  const tankAge = state.tank?.updatedAt ? Date.now() - state.tank.updatedAt : null
  const apexHost = config.apex?.host
  if (!apexHost) {
    out.push(check('apex', 'Apex controller', 'warn', 'not configured', 'No controller set, so the tank parameters come from nowhere.', 'Settings > Apex controller.'))
  } else if (state.tank?.error) {
    out.push(check('apex', 'Apex controller', 'fail', apexHost, `Not answering: ${state.tank.error}`,
      'Check the Apex is powered and on the same network; confirm its address and password in Settings.'))
  } else {
    const stale = tankAge != null && tankAge > 10 * 60 * 1000
    out.push(check('apex', 'Apex controller', stale ? 'fail' : 'ok', apexHost,
      `Last reading ${ago(state.tank?.updatedAt) ?? 'never'}`,
      stale ? 'Readings have stopped arriving.' : null))
  }

  // state.environment is only populated once a reading arrives, so after a
  // restart it is empty while the sensor is perfectly healthy. The database
  // is the honest source, exactly as /api/environment/latest uses it.
  let envTs = state.environment?.ts ?? null
  if (envTs == null) {
    try { envTs = db.prepare('SELECT ts FROM env_readings ORDER BY ts DESC LIMIT 1').get()?.ts ?? null } catch { /* fresh unit */ }
  }
  const envAge = envTs ? Date.now() - envTs : null
  out.push(check('sensor', 'Room-air sensor',
    envAge == null ? 'fail' : envAge > 15 * 60 * 1000 ? 'fail' : 'ok',
    envTs ? ago(envTs) : 'never reported',
    envAge == null || envAge > 15 * 60 * 1000 ? 'The SCD41 is not reporting. Nearly always power or a loose connector, not a dead sensor.' : null,
    envAge == null || envAge > 15 * 60 * 1000 ? 'See sensor/WIRING.md: 3V3 to pin 1, GND pin 9, SDA pin 3, SCL pin 5. An empty i2c scan means power or wiring.' : null))

  const rs = state.redsea?.devices ?? []
  if (config.redSea?.enabled === false) {
    out.push(check('redsea', 'Red Sea equipment', 'ok', 'switched off'))
  } else {
    const down = rs.filter((d) => !d.ok)
    out.push(check('redsea', 'Red Sea equipment', down.length ? 'warn' : 'ok',
      `${rs.length} found, ${down.length} not answering`,
      down.length ? `Not answering: ${down.map((d) => d.name ?? d.ip).join(', ')}. The firmware rate-limits, so brief misses are normal.` : null))
  }
  return out
}

// ---- configuration ----------------------------------------------------------
function configuration(config, state) {
  const out = []
  out.push(check('setup', 'Setup', config.setupComplete ? 'ok' : 'warn',
    config.setupComplete ? 'complete' : 'never completed',
    config.setupComplete ? null : 'The unit has never been through first-run setup.'))
  out.push(check('token', 'API token', config.apiToken ? 'ok' : 'fail',
    config.apiToken ? 'set' : 'missing',
    config.apiToken ? null : 'Without a token the API denies every request from the network.',
    config.apiToken ? null : 'Re-run setup, or restart the server - loadConfig mints one.'))
  const alerts = config.alerts ?? {}
  out.push(check('push', 'Phone alerts', alerts.ntfyTopic ? 'ok' : 'warn',
    alerts.ntfyTopic ? 'configured' : 'not configured',
    alerts.ntfyTopic ? null : 'On-screen alarms still work; nothing reaches a phone.'))
  const sound = config.sound ?? {}
  out.push(check('sound', 'Alarm sounds', sound.enabled === false ? 'warn' : 'ok',
    sound.enabled === false ? 'silenced' : 'on',
    sound.enabled === false ? 'The speakers will not sound for any alarm.' : null,
    sound.enabled === false ? 'Settings > Alarms & sounds.' : null))
  out.push(check('alerts', 'Active alerts', 'ok', String((state.alerts?.active ?? []).length)))
  return out
}

// ---- updates ----------------------------------------------------------------
// OTA is `git pull` (scripts/update.sh). A unit whose files were copied there
// rather than cloned has no remote to pull from, so it can never be updated -
// and nothing says so until an update is attempted in the field.
async function updates(repoRoot) {
  const head = await run('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'])
  if (!head) {
    return [check('updates', 'Software updates', 'fail', 'not a git checkout',
      'This unit\'s files were copied, not cloned, so there is no remote to pull from. Over-the-air updates cannot work.',
      'Re-image from the factory card, or clone the repository over this directory keeping config.json and data/.')]
  }
  const remote = await run('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'])
  if (!remote) {
    return [check('updates', 'Software updates', 'fail', head,
      'A git checkout with no origin remote; updates have nowhere to pull from.',
      'git remote add origin <url> - see docs/FACTORY.md.')]
  }
  // Being a checkout is not the same as being updatable. Ask the remote,
  // with prompting off so a repo needing credentials fails rather than hangs:
  // a unit that reports "updates: ok" and then cannot pull is worse than one
  // that admits it, because nobody looks again until an update is needed.
  const reach = await new Promise((resolve) => {
    execFile('git', ['-C', repoRoot, 'ls-remote', '--heads', 'origin', 'main'],
      { timeout: 12000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' } },
      // git says why on stderr, not in the Error - "could not read Username"
      // lives there, and it is the whole difference between "no network" and
      // "this unit has no credentials for your private repo".
      (err, stdout, stderr) => resolve(err
        ? { ok: false, err: (String(stderr || '').trim().split('\n').pop() || err.message).trim() }
        : { ok: true, out: stdout.trim() }))
  })
  if (!reach.ok) {
    const creds = /Username|Authentication|could not read|403|denied/i.test(reach.err ?? '')
    return [check('updates', 'Software updates', 'fail', head,
      creds
        ? `This unit cannot read ${remote} - it needs credentials it does not have, so updates will fail.`
        : `This unit cannot reach ${remote}: ${reach.err}`,
      creds
        ? 'Point units at a remote they can fetch anonymously, or bake a read-only deploy token into the URL. docs/FACTORY.md weighs the options.'
        : 'Check the unit\'s internet connection, then try Settings > Software update.')]
  }
  const behind = reach.out?.split(/\s+/)[0]?.slice(0, 7)
  return [check('updates', 'Software updates', 'ok', head,
    behind && !head.startsWith(behind.slice(0, 7)) ? `An update is available (${behind}).` : 'Up to date with the remote.')]
}

export async function collect({ config, state, db, dataDir, repoRoot }) {
  const [p, t, s, svc, net, upd] = await Promise.all([
    power(), thermal(), storage(dataDir), services(), network(), updates(repoRoot)
  ])
  const checks = [...p, ...t, ...svc, ...net, ...integrations(state, config, db), ...s, ...configuration(config, state), ...upd]

  let version = 'dev'
  try { version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim() } catch { /* not packaged */ }
  const commit = await run('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'])
  const model = (await run('cat', ['/proc/device-tree/model']))?.replace(/\0/g, '') ?? null

  let rows = null
  try {
    rows = {
      tank: db.prepare('SELECT COUNT(*) n FROM tank_readings').get().n,
      env: db.prepare('SELECT COUNT(*) n FROM env_readings').get().n,
      icp: db.prepare('SELECT COUNT(*) n FROM icp_tests').get().n
    }
  } catch { /* fresh unit */ }

  const worst = checks.some((c) => c.status === 'fail') ? 'fail'
    : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'

  return {
    generatedAt: Date.now(),
    identity: {
      tankName: config.tankName || null,
      version,
      commit,
      model,
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      nodeVersion: process.version
    },
    summary: {
      status: worst,
      fail: checks.filter((c) => c.status === 'fail').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      ok: checks.filter((c) => c.status === 'ok').length,
      unknown: checks.filter((c) => c.status === 'unknown').length
    },
    checks,
    rows
  }
}
