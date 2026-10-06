import React, { useEffect, useState } from 'react'
import { api, usePolling } from '../api.js'

// "A new version is ready." Appears on the home screen when the terminal has
// found a newer release (see the update announcements in
// server/src/routes/system.js). Two answers: Update now, or Later - which
// quietens this release for a day. Nothing installs unless Update now is
// tapped; first-run setup and Settings -> Update are unaffected.

// An update takes a minute or two and ends with the server restarting and the
// display reloading itself. One that fails rolls back and restarts the server
// without reloading the display - so the card would say "Updating…" for ever.
// This is how long to wait before calling it failed.
const UPDATE_PATIENCE_MS = 15 * 60 * 1000

export default function UpdateNotice() {
  // The server answers from what its last check found, so a short interval
  // costs nothing and the card shows up soon after a check finds a release.
  const [notice] = usePolling('/api/system/update/notice', 60 * 1000)
  const [hidden, setHidden] = useState(false)
  const [updating, setUpdating] = useState(null) // { commit, startedAt } while an update runs
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState(null)

  // While updating, watch the server. A new commit means the update landed
  // and the reload is on its way (or has happened). The same commit after
  // UPDATE_PATIENCE_MS means it rolled back.
  useEffect(() => {
    if (!updating) return
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled) return
      if (Date.now() - updating.startedAt > UPDATE_PATIENCE_MS) { setFailed(true); return }
      try {
        const v = await api('/api/system/version')
        if (!cancelled && v?.commit && updating.commit && v.commit !== updating.commit) location.reload()
      } catch { /* the server is restarting - expected */ }
    }, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [updating])

  if (updating && failed) {
    return (
      <div className="update-notice" role="alertdialog" aria-live="polite">
        <div className="update-notice-title">Update did not finish</div>
        <p className="update-notice-text">
          The display is still on the version it had. Nothing is lost. You can try again later from Settings → Update.
        </p>
        <div className="update-notice-actions">
          <button className="update-notice-dismiss" onClick={() => { setUpdating(null); setFailed(false); setHidden(true) }}>OK</button>
        </div>
      </div>
    )
  }

  if (updating) {
    return (
      <div className="update-notice" role="alertdialog" aria-live="polite">
        <div className="update-notice-title">Updating…</div>
        <p className="update-notice-text">The display will restart by itself in a minute or two. Please leave it powered on.</p>
      </div>
    )
  }

  if (!notice?.available || hidden) return null

  const later = () => {
    setHidden(true)
    api('/api/system/update/snooze', { method: 'POST' }).catch(() => {})
  }

  const now = async () => {
    setError(null)
    let commit = null
    try { commit = (await api('/api/system/version'))?.commit ?? null } catch { /* compared loosely below */ }
    try {
      await api('/api/system/update', { method: 'POST' })
      setUpdating({ commit, startedAt: Date.now() })
    } catch (err) {
      setError(String(err.message ?? err))
    }
  }

  return (
    <div className="update-notice" role="alertdialog" aria-live="polite">
      <div className="update-notice-title">Update available</div>
      <p className="update-notice-text">
        {notice.version ? `ReefGauge ${notice.version} is ready` : 'A new version of ReefGauge is ready'}
        {notice.current ? ` (you have ${notice.current})` : ''}.
        {' '}Updating takes a minute or two and the display restarts.
        {notice.channel === 'bench' ? ' (Early release from the bench channel.)' : ''}
      </p>
      {error && <p className="update-notice-error">{error}</p>}
      <div className="update-notice-actions">
        <button className="update-notice-later" onClick={later}>Later</button>
        <button className="update-notice-now" onClick={now}>Update now</button>
      </div>
    </div>
  )
}
