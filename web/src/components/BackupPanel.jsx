import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Settings → Backup.
//
// The terminal is screwed to a wall and its browser is a kiosk, so a browser
// download would save the file onto the Pi — which is the one place it is no
// use. So this is built around a USB stick: plug one in, tap Save, take it
// away. That is also the flow that survives the failure it exists for, which
// is the SD card in this unit dying.
//
// Restore is deliberately slower than saving. It replaces everything, and the
// person doing it is usually having a bad day already, so it shows what is in
// the file — whose tank, what date, how many readings — and makes them confirm
// against that rather than against a filename.

const ago = (iso) => {
  if (!iso) return null
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

const size = (b) => (!b ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)

const when = (iso) => {
  if (!iso) return 'unknown date'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function BackupPanel() {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(null)

  const load = () => api('/api/system/backup/usb').then(setInfo).catch((e) => setError(String(e.message ?? e)))
  useEffect(() => {
    load()
    // A stick plugged in while this panel is open should just appear.
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [])

  const save = async () => {
    setBusy(true); setError(null); setMsg(null)
    try {
      const r = await api('/api/system/backup/usb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      setMsg(`Saved ${r.file} to ${r.drive} (${size(r.bytes)}). You can take the drive out now.`)
      load()
    } catch (e) { setError(String(e.message ?? e)) } finally { setBusy(false) }
  }

  const restore = async (backup) => {
    setBusy(true); setError(null); setMsg(null)
    try {
      await api('/api/system/restore/usb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: backup.file })
      })
      setConfirming(null)
      setMsg('Restored. The terminal is restarting — this screen will come back in a moment.')
    } catch (e) { setError(String(e.message ?? e)); setConfirming(null) } finally { setBusy(false) }
  }

  const drives = info?.drives ?? []
  const backups = info?.backups ?? []

  if (confirming) {
    const m = confirming.manifest ?? {}
    return (
      <div className="setup-body">
        <h1>Restore this backup?</h1>
        <div className="backup-item">
          <div className="backup-item-name">{m.tankName || 'Unnamed tank'}</div>
          <div className="backup-item-meta">
            {when(m.createdAt)} · ReefGauge {m.version ?? '?'} · {size(confirming.bytes)}
          </div>
          {m.counts && (
            <div className="backup-item-meta">
              {m.counts.tank_readings ?? 0} readings · {m.counts.corals ?? 0} corals · {m.counts.icp_tests ?? 0} ICP tests
            </div>
          )}
        </div>
        <p className="setup-note">
          This replaces everything on this terminal — its settings, its equipment, and its whole
          history — with what is in that file. What is here now is kept on the terminal for a while
          in case this was the wrong file, but nothing about it will be on screen any more.
        </p>
        <p className="setup-note">The terminal will restart to finish.</p>
        <button className="setup-primary danger" onClick={() => restore(confirming)} disabled={busy}>
          {busy ? 'Restoring…' : 'Yes, restore it'}
        </button>
        <button className="setup-primary ghost" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
        {error && <div className="setup-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="setup-body">
      <h1>Backup</h1>
      <p>
        A backup holds everything you set up and everything this tank has recorded — your equipment,
        your ranges, your test history, your coral journal and your photos. If this terminal is ever
        replaced, a backup puts it all back in a couple of minutes.
      </p>

      <div className={info && !info.lastBackupAt ? 'backup-state bad' : 'backup-state'}>
        {info == null ? 'Checking…'
          : info.lastBackupAt ? `Last saved ${ago(info.lastBackupAt)}`
          : 'This terminal has never been backed up'}
      </div>

      {drives.length === 0 ? (
        <div className="setup-note">
          Plug a USB drive into the back of the terminal and it will appear here.
        </div>
      ) : (
        <>
          <button className="setup-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : `Save to ${drives[0].label}`}
          </button>
          <div className="setup-note">
            Keep the file somewhere safe. It holds the passwords this terminal uses to reach your
            equipment, so treat it like a password of your own.
          </div>
        </>
      )}

      {backups.length > 0 && (
        <>
          <h2>On this drive</h2>
          {backups.map((b) => (
            <button key={b.file} className="backup-item tappable" onClick={() => setConfirming(b)} disabled={busy}>
              <div className="backup-item-name">{b.manifest?.tankName || b.name}</div>
              <div className="backup-item-meta">
                {when(b.manifest?.createdAt)} · {size(b.bytes)}
                {b.manifest?.counts?.tank_readings ? ` · ${b.manifest.counts.tank_readings} readings` : ''}
              </div>
              <div className="backup-item-action">Restore</div>
            </button>
          ))}
        </>
      )}

      {msg && <div className="setup-ok">{msg}</div>}
      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
