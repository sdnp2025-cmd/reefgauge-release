// Ring doorbell integration via the community ring-client-api library
// (Ring has no official public API). Auth is a refresh token generated once
// with `npx -p ring-client-api ring-auth-cli`; Ring rotates it on every use,
// so updates are persisted to data/ring-token.txt automatically.

import fs from 'node:fs'
import path from 'node:path'

let snapshot = null // latest JPEG Buffer

export function getRingSnapshot() {
  return snapshot
}

export function startRingListener(config, state, dataDir) {
  const ringConfig = config.ring
  if (!ringConfig?.refreshToken) {
    state.ring.error = 'not configured'
    return
  }

  // Dynamic import: the dashboard keeps working even if the optional
  // dependency is missing or Ring is unreachable.
  import('ring-client-api').then(async ({ RingApi }) => {
    const tokenFile = path.join(dataDir, 'ring-token.txt')
    const refreshToken = fs.existsSync(tokenFile)
      ? fs.readFileSync(tokenFile, 'utf8').trim()
      : ringConfig.refreshToken

    const ring = new RingApi({ refreshToken })
    ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
      fs.writeFileSync(tokenFile, newRefreshToken)
    })

    const cameras = await ring.getCameras()
    const camera = ringConfig.cameraName
      ? cameras.find((c) => c.name === ringConfig.cameraName)
      : cameras.find((c) => c.isDoorbot) ?? cameras[0]
    if (!camera) {
      state.ring.error = 'no Ring cameras found on this account'
      return
    }
    state.ring.camera = camera.name
    state.ring.error = null
    console.log(`Ring: watching "${camera.name}" for doorbell presses`)

    camera.onDoorbellPressed.subscribe(async () => {
      state.ring.lastDing = Date.now()
      try {
        snapshot = await camera.getSnapshot()
        state.ring.snapshotAt = Date.now()
      } catch (err) {
        console.warn('Ring snapshot failed:', err.message)
      }
    })
  }).catch((err) => {
    state.ring.error = `ring-client-api unavailable: ${err.message}`
    console.warn(state.ring.error)
  })
}
