// Backup and restore of everything a customer would hate to lose.
//
// The failure this exists for: an SD card dies, or a unit is replaced under
// warranty, and someone who spent an evening pairing an Apex, naming six Red
// Sea pumps and dialling in their ranges has to do all of it again - and their
// chemistry history, their coral journal and their photos are simply gone.
// Nothing about a reef tank is reproducible from a fresh install.
//
// Three decisions worth defending, because each of them is a place this could
// quietly do the wrong thing:
//
//   The API token is never in the backup. It is this unit's credential, not
//   the customer's setting. Putting it in a file that lives on a USB stick
//   would leak it, and restoring it onto a replacement would leave two units
//   answering to the same token. The target always keeps its own.
//
//   The secrets that ARE settings do travel - the Apex password, the Ring
//   refresh token, the ntfy topic - because a restore that silently drops them
//   leaves a unit that looks configured and is not. That makes the backup file
//   sensitive in a way the support bundle deliberately is not, and everything
//   that touches it says so.
//
//   The database is copied through SQLite's own online backup, not the
//   filesystem. The database runs in WAL mode; a plain file copy takes the
//   main file without the write-ahead log and can produce an archive that
//   restores to a database missing its most recent writes - the failure that
//   looks fine until someone checks last week's alkalinity.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { saveConfigAtomic } from './config.js'

const exec = promisify(execFile)

export const BACKUP_FORMAT = 1

// Machine-local, and meaningless on a different unit. Stripped going out so
// they never sit in the file, and preserved coming in so a restore cannot
// point a unit at another machine's paths or steal its identity.
const UNIT_LOCAL_KEYS = ['apiToken', 'port', 'db', 'configPath']

const rm = (p) => fs.rmSync(p, { recursive: true, force: true })

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `reefgauge-${tag}-`))
}

/**
 * Writes a .tar.gz to `outFile`. Returns the manifest that went into it.
 */
export async function createBackup({ config, db, version, tankName, includePhotos = true, outFile }) {
  const staging = tmpdir('backup')
  try {
    const dataDir = path.dirname(config.db)

    // Settings, less the things that belong to the machine rather than the
    // customer. A shallow copy is enough: the keys removed are all top level.
    const settings = { ...config }
    for (const k of UNIT_LOCAL_KEYS) delete settings[k]
    fs.writeFileSync(path.join(staging, 'config.json'), JSON.stringify(settings, null, 2))

    // SQLite's own backup, which is consistent against a live database.
    await db.backup(path.join(staging, 'reef.db'))

    const included = ['config.json', 'reef.db']
    if (includePhotos) {
      for (const dir of ['photos', 'coral-photos']) {
        const src = path.join(dataDir, dir)
        if (!fs.existsSync(src)) continue
        fs.cpSync(src, path.join(staging, dir), { recursive: true })
        included.push(dir + '/')
      }
    }

    const counts = {}
    for (const t of ['tank_readings', 'env_readings', 'icp_tests', 'corals',
                     'coral_photos', 'dose_log', 'water_changes', 'maint_tasks']) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n } catch { /* table may predate this build */ }
    }

    const manifest = {
      format: BACKUP_FORMAT,
      product: 'ReefGauge',
      version,                       // refuse to restore this onto older software
      createdAt: new Date().toISOString(),
      tankName: tankName ?? config.tankName ?? null,
      includes: included,
      counts,
      // Said in the file itself, so it is still true when the file turns up on
      // a USB stick two years from now with no other context around it.
      contains_secrets: true,
      notice: 'This file contains the settings for a ReefGauge terminal, including ' +
              'the passwords and tokens it uses to reach your equipment. Treat it ' +
              'like a password. It does NOT contain the terminal\'s own API token.',
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))

    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    await exec('tar', ['-czf', outFile, '-C', staging, '.'])
    fs.chmodSync(outFile, 0o600)

    manifest.bytes = fs.statSync(outFile).size
    return manifest
  } finally {
    rm(staging)
  }
}

/**
 * Unpacks `archive` over this unit's data. Does not restart anything - the
 * caller restarts the server, because a process holding the old database open
 * cannot be the one to swap it.
 */
export async function restoreBackup({ archive, config, version, dryRun = false }) {
  const staging = tmpdir('restore')
  try {
    await exec('tar', ['-xzf', archive, '-C', staging])

    const manifestPath = path.join(staging, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error('that is not a ReefGauge backup - no manifest inside')
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    if (manifest.format > BACKUP_FORMAT) {
      throw new Error(`this backup is format ${manifest.format} and this terminal understands ${BACKUP_FORMAT}. Update the terminal first.`)
    }
    // Newer data onto older software restores a database with columns this
    // build has never heard of. Refusing is recoverable; a half-migrated
    // database is not.
    if (manifest.version && version && cmpVersion(manifest.version, version) > 0) {
      throw new Error(`this backup came from ReefGauge ${manifest.version} and this terminal runs ${version}. Update the terminal, then restore.`)
    }

    const plan = {
      manifest,
      willRestore: manifest.includes ?? [],
      keepsOwn: UNIT_LOCAL_KEYS,
    }
    if (dryRun) return plan

    const dataDir = path.dirname(config.db)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    // Everything replaced moves aside rather than being deleted. A restore is
    // exactly when someone discovers they picked the wrong file, and at that
    // moment the thing they overwrote is the only copy left.
    const aside = path.join(dataDir, `pre-restore-${stamp}`)
    fs.mkdirSync(aside, { recursive: true })

    const src = path.join(staging, 'config.json')
    if (fs.existsSync(src)) {
      const incoming = JSON.parse(fs.readFileSync(src, 'utf8'))
      fs.copyFileSync(config.configPath, path.join(aside, 'config.json'))
      // The unit keeps its own identity and paths; everything else is theirs.
      const merged = { ...incoming }
      for (const k of UNIT_LOCAL_KEYS) {
        if (config[k] !== undefined) merged[k] = config[k]
      }
      delete merged.configPath
      saveConfigAtomic(config.configPath, merged)
    }

    const dbSrc = path.join(staging, 'reef.db')
    if (fs.existsSync(dbSrc)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const live = config.db + suffix
        if (fs.existsSync(live)) fs.renameSync(live, path.join(aside, path.basename(live)))
      }
      fs.copyFileSync(dbSrc, config.db)
    }

    for (const dir of ['photos', 'coral-photos']) {
      const from = path.join(staging, dir)
      if (!fs.existsSync(from)) continue
      const to = path.join(dataDir, dir)
      if (fs.existsSync(to)) fs.renameSync(to, path.join(aside, dir))
      fs.cpSync(from, to, { recursive: true })
    }

    return { ...plan, restored: true, previousDataKeptAt: aside }
  } finally {
    rm(staging)
  }
}

// "0.10.0" is newer than "0.9.0"; a string compare disagrees.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

// ---- removable media --------------------------------------------------------
//
// The terminal is screwed to a wall and its browser is a kiosk, so "download
// the backup" saves the file onto the Pi, which helps nobody. For an appliance
// the honest answer is a USB stick: the customer plugs one in, taps Save, and
// takes the stick away. The HTTP download stays for a computer on the LAN and
// for warranty replacement, but the stick is the flow that works for the
// person standing in front of the tank.

const BACKUP_EXT = '.reefgauge'

/** Mounted removable drives, with free space. */
export async function listDrives() {
  const drives = []
  try {
    const { stdout } = await exec('lsblk', ['-J', '-b', '-o', 'NAME,RM,TYPE,SIZE,FSAVAIL,LABEL,MOUNTPOINT'], { timeout: 5000 })
    const walk = (nodes, removable = false) => {
      for (const n of nodes ?? []) {
        const rm = removable || n.rm === true || n.rm === '1'
        if (rm && n.mountpoint && n.type === 'part') {
          drives.push({
            label: n.label || n.name,
            path: n.mountpoint,
            freeBytes: Number(n.fsavail ?? 0),
            sizeBytes: Number(n.size ?? 0)
          })
        }
        walk(n.children, rm)
      }
    }
    walk(JSON.parse(stdout).blockdevices)
  } catch {
    // lsblk missing or refusing: udisks2 mounts sticks under /media/<user>/,
    // so the directory listing is a decent second answer.
    const base = '/media'
    try {
      for (const user of fs.readdirSync(base)) {
        for (const vol of fs.readdirSync(path.join(base, user))) {
          drives.push({ label: vol, path: path.join(base, user, vol), freeBytes: 0, sizeBytes: 0 })
        }
      }
    } catch { /* nothing mounted */ }
  }
  // The card the terminal boots from is not somewhere to put its own backup.
  return drives.filter((d) => d.path !== '/' && !d.path.startsWith('/boot'))
}

/** Reads one archive's manifest without unpacking the rest of it. */
export async function readManifest(file) {
  try {
    const { stdout } = await exec('tar', ['-xzOf', file, './manifest.json'], { timeout: 15000 })
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/** Every ReefGauge backup on every mounted stick, newest first. */
export async function listBackupsOnDrives() {
  const out = []
  for (const drive of await listDrives()) {
    let names = []
    try { names = fs.readdirSync(drive.path) } catch { continue }
    for (const name of names) {
      if (!name.endsWith(BACKUP_EXT)) continue
      const file = path.join(drive.path, name)
      let size = 0
      try { size = fs.statSync(file).size } catch { continue }
      out.push({ drive: drive.label, file, name, bytes: size, manifest: await readManifest(file) })
    }
  }
  return out.sort((a, b) =>
    String(b.manifest?.createdAt ?? '').localeCompare(String(a.manifest?.createdAt ?? '')))
}

export function backupFileName(tankName) {
  const safe = String(tankName || 'reefgauge').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'reefgauge'
  return `${safe}-${new Date().toISOString().slice(0, 10)}${BACKUP_EXT}`
}
