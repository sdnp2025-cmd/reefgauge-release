// Version + over-the-air updates: pull the latest main from the git remote,
// rebuild, and restart services (scripts/update.sh; sudoers rule installed
// by pi/install.sh allows the systemctl restarts).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { saveConfigAtomic } from '../config.js'
import { collect } from '../diagnostics.js'
import { createBackup, restoreBackup, listDrives, listBackupsOnDrives, backupFileName } from '../backup.js'

const exec = promisify(execFile)
const DEMO = !!process.env.DEMO

// config is also the live object the server reads, and load() decorates it
// with where it came from. Writing that back would persist a path into the
// file that describes the file.
const stripRuntime = (c) => { const o = { ...c }; delete o.configPath; delete o.serverRoot; return o }

export default async function systemRoutes(app, { config, state, db, support }) {
  const repoRoot = path.resolve(config.serverRoot, '..')
  const readVersion = () => {
    try { return fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim() } catch { return 'dev' }
  }

  app.get('/api/system/version', async () => {
    let commit = null
    try {
      commit = (await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })).stdout.trim()
    } catch { /* not a git checkout */ }
    return { version: readVersion(), commit }
  })

  // Everything a support session needs, graded. Deliberately one call: a
  // customer on the phone is not going to run six.
  app.get('/api/system/diagnostics', async (req, reply) => {
    try {
      return await collect({
        config,
        state,
        db,
        dataDir: path.dirname(config.db),
        repoRoot
      })
    } catch (err) {
      return reply.code(500).send({ error: `diagnostics failed: ${err.message}` })
    }
  })

  // The same thing plus recent logs, for a customer who can only email. No
  // secrets: the config is redacted here rather than at the far end, because
  // the far end is an inbox.
  app.get('/api/system/support-bundle', async (req, reply) => {
    const diag = await collect({ config, state, db, dataDir: path.dirname(config.db), repoRoot })
    const redacted = JSON.parse(JSON.stringify(config))
    for (const key of ['apiToken', 'password']) delete redacted[key]
    if (redacted.apex) delete redacted.apex.password
    if (redacted.alerts) delete redacted.alerts.ntfyTopic
    delete redacted.google
    const logs = {}
    for (const unit of ['reef-server.service', 'co2-daemon.service']) {
      try {
        logs[unit] = (await exec('journalctl', ['-u', unit, '-n', '200', '--no-pager'], { timeout: 15000 })).stdout
      } catch (err) {
        logs[unit] = `(unavailable: ${err.message})`
      }
    }
    reply.header('Content-Disposition', `attachment; filename="reefgauge-support-${new Date().toISOString().slice(0, 10)}.json"`)
    return { diagnostics: diag, config: redacted, logs }
  })

  // ---- remote support ----
  // Opened only from the terminal itself (the auth hook already refuses
  // /api/support/* from the network without the unit's token, and the tile
  // that calls it is on the glass).
  app.get('/api/support/session', async () => support?.status() ?? { active: false, unavailable: true })

  app.post('/api/support/session', async (req, reply) => {
    if (!support) return reply.code(503).send({ error: 'remote support is not configured on this unit' })
    support.start()
    // The code arrives over the relay a moment later; the UI polls for it.
    return support.status()
  })

  app.delete('/api/support/session', async (req, reply) => {
    if (!support) return reply.code(503).send({ error: 'remote support is not configured on this unit' })
    return support.end()
  })

  // ---- repair ----
  // The three things a support session actually does, as named commands
  // rather than a shell. An allowlist, because "restart a service" must not
  // become "run anything as this user" the moment a token leaks.
  const UNITS = {
    server: { scope: 'system', unit: 'reef-server.service' },
    sensor: { scope: 'system', unit: 'co2-daemon.service' },
    display: { scope: 'user', unit: 'reef-kiosk.service' }
  }

  app.post('/api/system/restart/:target', async (req, reply) => {
    const target = UNITS[req.params.target]
    if (!target) return reply.code(400).send({ error: `unknown service; expected one of ${Object.keys(UNITS).join(', ')}` })
    const args = target.scope === 'user'
      ? ['--user', 'restart', target.unit]
      : ['restart', target.unit]
    const cmd = target.scope === 'user' ? 'systemctl' : 'sudo'
    const argv = target.scope === 'user' ? args : ['-n', 'systemctl', ...args]
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` }
    // Restarting the server kills this request, so answer first and act after.
    if (req.params.target === 'server') {
      reply.send({ ok: true, restarting: target.unit })
      setTimeout(() => { spawn(cmd, argv, { env, detached: true, stdio: 'ignore' }).unref() }, 250)
      return reply
    }
    try {
      await exec(cmd, argv, { env, timeout: 30000 })
      return { ok: true, restarted: target.unit }
    } catch (err) {
      return reply.code(500).send({ error: `could not restart ${target.unit}: ${err.message}` })
    }
  })

  // ---- backup and restore --------------------------------------------------
  //
  // The thing a customer cannot rebuild: their equipment pairings, their
  // ranges, their chemistry history, their coral journal, their photos. A dead
  // SD card should cost an afternoon of waiting for hardware, not an evening
  // of re-entering everything and the permanent loss of two years of readings.
  //
  // This is deliberately NOT on the support-session allowlist. The archive
  // carries the Apex password and the Ring refresh token, and the support
  // panel promises the customer in plain words that support sees how the
  // terminal is working and not their tank's history. A backup is both of
  // those things at once, so it stays something the owner takes, on their own
  // network, to their own disk.

  app.get('/api/system/backup', async (req, reply) => {
    const includePhotos = req.query?.photos !== '0'
    const stamp = new Date().toISOString().slice(0, 10)
    const safeName = String(config.tankName || 'reefgauge').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'reefgauge'
    const outFile = path.join(os.tmpdir(), `reefgauge-backup-${process.pid}-${Date.now()}.tar.gz`)
    try {
      const manifest = await createBackup({
        config, db, version: readVersion(),
        tankName: config.tankName, includePhotos, outFile
      })
      reply.header('content-type', 'application/gzip')
      reply.header('content-length', manifest.bytes)
      reply.header('content-disposition', `attachment; filename="${safeName}-${stamp}.reefgauge"`)
      const stream = fs.createReadStream(outFile)
      // Delete once it is on the wire either way; a half-sent archive left in
      // /tmp is a copy of the customer's credentials nobody is watching.
      stream.on('close', () => { try { fs.unlinkSync(outFile) } catch {} })
      return reply.send(stream)
    } catch (err) {
      try { fs.unlinkSync(outFile) } catch {}
      return reply.code(500).send({ error: `backup failed: ${err.message}` })
    }
  })

  // What the wall-mounted unit actually offers: the sticks it can see, the
  // backups already on them, and a one-tap save. Everything the panel needs to
  // draw itself comes back in one call, because it is drawn on a touchscreen
  // by someone holding a USB stick.
  app.get('/api/system/backup/usb', async () => ({
    drives: await listDrives(),
    backups: await listBackupsOnDrives(),
    lastBackupAt: config.lastBackupAt ?? null
  }))

  app.post('/api/system/backup/usb', async (req, reply) => {
    const drives = await listDrives()
    const drive = req.body?.path ? drives.find((d) => d.path === req.body.path) : drives[0]
    if (!drive) return reply.code(400).send({ error: 'no USB drive is plugged in' })

    const outFile = path.join(drive.path, backupFileName(config.tankName))
    try {
      const manifest = await createBackup({
        config, db, version: readVersion(), tankName: config.tankName,
        includePhotos: req.body?.photos !== false, outFile
      })
      // Flush before telling anyone it is safe to pull the stick out. Without
      // this the file is in the page cache and a stick removed straight after
      // the success message can carry an empty or truncated archive.
      try { await exec('sync', [], { timeout: 30000 }) } catch { /* best effort */ }

      config.lastBackupAt = new Date().toISOString()
      try { saveConfigAtomic(config.configPath, stripRuntime(config)) } catch { /* not worth failing the backup over */ }

      return { ok: true, drive: drive.label, file: path.basename(outFile), ...manifest }
    } catch (err) {
      try { fs.unlinkSync(outFile) } catch {}
      return reply.code(500).send({ error: `could not write to ${drive.label}: ${err.message}` })
    }
  })

  app.post('/api/system/restore/usb', async (req, reply) => {
    const wanted = req.body?.file
    const found = (await listBackupsOnDrives()).find((b) => b.file === wanted)
    if (!found) return reply.code(404).send({ error: 'that backup is no longer on the drive' })
    const dryRun = req.body?.dryRun === true
    try {
      const result = await restoreBackup({ archive: found.file, config, version: readVersion(), dryRun })
      if (dryRun) return { ok: true, dryRun: true, ...result }
      reply.send({ ok: true, ...result, restarting: 'reef-server.service' })
      setTimeout(() => {
        spawn('sudo', ['-n', 'systemctl', 'restart', 'reef-server.service'],
              { detached: true, stdio: 'ignore' }).unref()
      }, 250)
      return reply
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })

  app.post('/api/system/restore', async (req, reply) => {
    const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true'
    const upload = await req.file?.({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
    if (!upload) return reply.code(400).send({ error: 'send the backup file as multipart form data' })

    const incoming = path.join(os.tmpdir(), `reefgauge-restore-${process.pid}-${Date.now()}.tar.gz`)
    try {
      await pipeline(upload.file, fs.createWriteStream(incoming))
      if (upload.file.truncated) return reply.code(413).send({ error: 'that file is too large' })

      const result = await restoreBackup({ archive: incoming, config, version: readVersion(), dryRun })
      if (dryRun) return { ok: true, dryRun: true, ...result }

      // The database this process has open is the one that was just moved
      // aside, so nothing is actually restored until the server restarts.
      // Answer first, then go.
      reply.send({ ok: true, ...result, restarting: 'reef-server.service' })
      setTimeout(() => {
        spawn('sudo', ['-n', 'systemctl', 'restart', 'reef-server.service'],
              { detached: true, stdio: 'ignore' }).unref()
      }, 250)
      return reply
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    } finally {
      try { fs.unlinkSync(incoming) } catch {}
    }
  })

  app.post('/api/system/reboot', async (req, reply) => {
    if (DEMO) return { ok: true, demo: true }
    reply.send({ ok: true, rebooting: true })
    setTimeout(() => {
      spawn('sudo', ['-n', 'systemctl', 'reboot'], { detached: true, stdio: 'ignore' }).unref()
    }, 500)
    return reply
  })

  app.get('/api/system/logs', async (req, reply) => {
    const units = { server: 'reef-server.service', sensor: 'co2-daemon.service' }
    const unit = units[req.query?.unit ?? 'server']
    if (!unit) return reply.code(400).send({ error: `unknown unit; expected one of ${Object.keys(units).join(', ')}` })
    const lines = Math.min(Number(req.query?.lines ?? 100) || 100, 1000)
    try {
      const { stdout } = await exec('journalctl', ['-u', unit, '-n', String(lines), '--no-pager'], { timeout: 20000 })
      return { unit, lines: stdout.split('\n') }
    } catch (err) {
      return reply.code(500).send({ error: `could not read the log: ${err.message}` })
    }
  })

  app.get('/api/system/update/check', async (req, reply) => {
    if (DEMO) return { version: readVersion(), behind: 0, latest: null }
    try {
      await exec('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: repoRoot, timeout: 30000 })
      const behind = Number((await exec('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: repoRoot })).stdout.trim())
      const latest = behind > 0
        ? (await exec('git', ['log', '-1', '--format=%s', 'origin/main'], { cwd: repoRoot })).stdout.trim()
        : null
      return { version: readVersion(), behind, latest }
    } catch (err) {
      return reply.code(502).send({ error: `update check failed: ${err.message}` })
    }
  })

  app.post('/api/system/update', async (req, reply) => {
    if (DEMO) return { ok: true, demo: true }
    const script = path.join(repoRoot, 'scripts', 'update.sh')
    if (!fs.existsSync(script)) return reply.code(500).send({ error: 'update script missing' })
    // Detached: the update restarts this very server at the end
    const child = spawn('bash', [script], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore',
        fs.openSync('/tmp/reef-update.log', 'w'),
        fs.openSync('/tmp/reef-update.log', 'a')]
    })
    child.unref()
    return { ok: true, updating: true }
  })
}
