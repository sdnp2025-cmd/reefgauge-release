import React, { useEffect, useRef, useState } from 'react'
import { api, usePolling } from '../api.js'

// No emoji anywhere on the kiosk — the Pi image has no colour-emoji font.
const S = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const PictureIcon = <svg {...S} className="ico"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-4.6-4.6a2 2 0 0 0-2.8 0L5 19" /></svg>

// The QR is the whole authorisation: whoever can see the terminal's screen can
// add photos from their phone for the next half hour. The code is minted fresh
// each time this opens so one left on screen overnight is already dead.
function PhoneQr() {
  const [qr, setQr] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    api('/api/setup/qr?scope=photos').then(setQr).catch((err) => setError(err.message))
  }, [])
  if (error) return <div className="photo-qr-panel"><div className="setup-error">{error}</div></div>
  if (!qr) return null
  return (
    <div className="photo-qr-panel">
      <div className="setup-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
      <div className="setup-qr-text">
        <b>Scan with a phone camera</b> to add pictures from your camera roll —
        no app, no account. Everyone in the room can scan it.
        <br /><span className="setup-note-inline">{qr.url}</span>
        <br /><span className="setup-note-inline">The link stops working after {qr.expiresInMinutes} minutes.</span>
      </div>
    </div>
  )
}

export default function PhotoManager({ onClose }) {
  const [data, refetch] = usePolling('/api/photos', 30000)
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const fileInput = useRef(null)
  const photos = data?.photos ?? []

  const upload = async (e) => {
    const files = [...e.target.files]
    if (!files.length) return
    setBusy(true)
    try {
      const form = new FormData()
      for (const f of files) form.append('photos', f)
      await api('/api/photos', { method: 'POST', body: form })
      refetch()
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  const remove = async (photo) => {
    await api(`/api/photos/${encodeURIComponent(photo.name)}`, { method: 'DELETE' })
    refetch()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="photo-manager" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="month-title">{PictureIcon} Slideshow Photos</div>
          <div className="month-nav">
            <button className={qrOpen ? 'active' : ''} onClick={() => setQrOpen(!qrOpen)}>
              {qrOpen ? 'Hide code' : 'Add from phone'}
            </button>
            <button onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? 'Uploading…' : '＋ Add photos'}
            </button>
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {qrOpen && <PhoneQr />}
        <p className="photo-hint">
          Photos rotate as a full-screen slideshow when the display is idle.
          Add them from any phone with “Add from phone”.
        </p>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={upload} />
        {!photos.length && <div className="empty-note">No photos yet — add some!</div>}
        <div className="photo-grid">
          {photos.map((p) => (
            <div key={p.name} className="photo-thumb">
              <img src={p.url} alt="" loading="lazy" />
              <button className="photo-delete" onClick={() => remove(p)} aria-label="Delete photo">✕</button>
            </div>
          ))}
        </div>
        <div className="hub-save photo-done">
          <button className="setup-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
