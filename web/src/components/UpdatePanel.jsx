import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Shown on the wizard's welcome screen when reconfiguring: version + OTA update.
export default function UpdatePanel() {
  const [version, setVersion] = useState(null)
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState(false)
  // Which release channel this unit follows. Customers never see the switch:
  // it appears after tapping the version line five times, and the server only
  // honours it from the terminal itself. A unit on the bench channel always
  // says so, so nobody forgets which one they are looking at.
  const [channel, setChannel] = useState('main')
  const [taps, setTaps] = useState(0)
  const [chanMsg, setChanMsg] = useState(null)

  useEffect(() => {
    api('/api/system/version').then(setVersion).catch(() => {})
    api('/api/system/update/channel').then((c) => setChannel(c.channel)).catch(() => {})
  }, [])

  const chooseChannel = async (want) => {
    setChanMsg(null)
    try {
      const res = await api('/api/system/update/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: want })
      })
      setChannel(res.channel)
      setCheck(null)
      setChanMsg(res.available ? 'Switched. An update is waiting - tap Check for updates.' : 'Switched. Nothing newer there yet.')
    } catch (err) {
      setChanMsg(String(err.message ?? err))
    }
  }

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
      <span onClick={() => setTaps((t) => t + 1)}>
        Version {version?.version ?? '…'}{version?.commit ? ` (${version.commit})` : ''}
        {channel === 'bench' ? ' · bench channel' : ''}
      </span>
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
      {(taps >= 5 || channel === 'bench') && (
        <div className="update-channel">
          <span className="update-note">Release channel</span>
          <button className={channel === 'main' ? 'setup-primary compact' : 'setup-skip'} onClick={() => chooseChannel('main')}>Customers</button>
          <button className={channel === 'bench' ? 'setup-primary compact' : 'setup-skip'} onClick={() => chooseChannel('bench')}>Bench (early)</button>
          {chanMsg && <span className="update-note">{chanMsg}</span>}
        </div>
      )}
    </div>
  )
}
