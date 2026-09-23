import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Shown on the wizard's welcome screen when reconfiguring: version + OTA update.
export default function UpdatePanel() {
  const [version, setVersion] = useState(null)
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    api('/api/system/version').then(setVersion).catch(() => {})
  }, [])

  const runCheck = async () => {
    setBusy(true)
    try {
      setCheck(await api('/api/system/update/check'))
    } catch (err) {
      setCheck({ error: String(err.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    await api('/api/system/update', { method: 'POST' })
    setUpdating(true)
  }

  if (updating) {
    return <div className="update-panel"><b>Updating…</b> the display will restart itself in a minute or two.</div>
  }

  return (
    <div className="update-panel">
      <span>Version {version?.version ?? '…'}{version?.commit ? ` (${version.commit})` : ''}</span>
      {check == null ? (
        <button className="setup-skip" onClick={runCheck} disabled={busy}>{busy ? 'Checking…' : 'Check for updates'}</button>
      ) : check.error ? (
        <span className="update-note">{check.error}</span>
      ) : check.behind > 0 ? (
        <button className="setup-primary compact" onClick={install}>
          Install update ({check.behind} change{check.behind === 1 ? '' : 's'})
        </button>
      ) : (
        <span className="update-note">✓ Up to date</span>
      )}
    </div>
  )
}
