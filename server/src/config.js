import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Config is rewritten while the unit is running (setup wizard, Apex input
// remap). A wall device gets unplugged, so a torn write here would leave
// unparseable JSON and a unit that boot-loops with no way in. Write to a
// temp file, fsync it, then rename — rename is atomic on the same filesystem.
export function saveConfigAtomic(configPath, data) {
  const tmp = `${configPath}.tmp`
  const json = JSON.stringify(data, null, 2)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, configPath)
  // fsync the directory so the rename itself survives power loss.
  try {
    const dir = fs.openSync(path.dirname(configPath), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename still stands.
  }
}

export function loadConfig() {
  const configPath = path.join(serverRoot, 'config.json')
  const examplePath = path.join(serverRoot, 'config.example.json')
  let file = configPath
  let isExample = false

  if (!fs.existsSync(configPath)) {
    console.warn('config.json not found — falling back to config.example.json. The setup wizard will run.')
    file = examplePath
    isExample = true
  }

  let config
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // A corrupt config used to be fatal on every boot. Fall back to the
    // example so the unit still comes up and can be re-run through the wizard,
    // and keep the bad file for diagnosis rather than silently destroying it.
    console.error(`config.json is unreadable (${err.message}) — falling back to defaults so the unit can still boot`)
    try { fs.renameSync(configPath, `${configPath}.corrupt`) } catch {}
    config = JSON.parse(fs.readFileSync(examplePath, 'utf8'))
    file = examplePath
    isExample = true
  }

  config.serverRoot = serverRoot
  config.configPath = configPath
  config.examplePath = examplePath
  config.isExample = isExample
  config.db = path.resolve(serverRoot, config.db ?? './data/reef.db')


  // Fail closed. The API token used to be generated only when the wizard
  // finished, and an empty token disabled auth entirely — so every unit was
  // wide open on the customer's network until its final setup tap, and forever
  // if the wizard was skipped. Mint one now and persist it.
  //
  // A unit still running off config.example.json gets one too, in memory only
  // (there is no config.json to write it into yet). Without it the example's
  // empty token made the API answer every LAN request with 503 — including the
  // phone hand-off the wizard puts on screen during that exact window.
  if (!config.apiToken) {
    config.apiToken = crypto.randomBytes(16).toString('hex')
    if (isExample) {
      console.log('Unconfigured unit — using a temporary API token until setup completes')
    } else {
      try {
        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        onDisk.apiToken = config.apiToken
        saveConfigAtomic(configPath, onDisk)
        console.log('Generated a unique API token for this unit')
      } catch (err) {
        console.warn(`could not persist the generated API token: ${err.message}`)
      }
    }
  }

  return config
}

export const PARAM_META = {
  temp: { label: 'Temperature', unit: '°F' },
  ph: { label: 'pH', unit: '' },
  salinity: { label: 'Salinity', unit: 'ppt' },
  alk: { label: 'Alkalinity', unit: 'dKH' },
  ca: { label: 'Calcium', unit: 'ppm' },
  mg: { label: 'Magnesium', unit: 'ppm' },
  no3: { label: 'Nitrate', unit: 'ppm' },
  po4: { label: 'Phosphate', unit: 'ppm' }
}
