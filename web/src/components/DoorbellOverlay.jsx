import React, { useState } from 'react'
import { usePolling } from '../api.js'

// When someone presses the Ring doorbell, the camera snapshot takes over the
// screen for ~45 s (or until tapped away).
export default function DoorbellOverlay() {
  const [status] = usePolling('/api/ring/status', 3000)
  const [dismissed, setDismissed] = useState(null)

  const show = status?.active && status.lastDing !== dismissed
  if (!show) return null

  return (
    <div className="doorbell" onPointerDown={() => setDismissed(status.lastDing)}>
      <div className="doorbell-header">
        <span className="doorbell-bell">🔔</span>
        <div>
          <div className="doorbell-title">Someone's at the {status.camera ?? 'door'}!</div>
          <div className="doorbell-time">
            {new Date(status.lastDing).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {' · tap to dismiss'}
          </div>
        </div>
      </div>
      {status.hasSnapshot ? (
        <img className="doorbell-image" src={`/api/ring/snapshot.jpg?t=${status.snapshotAt}`} alt="Doorbell camera" />
      ) : (
        <div className="doorbell-placeholder">
          <span>📷</span>
          <p>Fetching camera snapshot…</p>
        </div>
      )}
    </div>
  )
}
