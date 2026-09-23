import React, { useEffect, useRef, useState } from 'react'
import { api, authHeaders } from '../api.js'

// The page a family phone lands on after scanning the QR shown on the
// terminal. It is the same bundle as the kiosk, but nothing here assumes a
// 1080p touchscreen: real inputs, real keyboard, thumb-sized targets.
//
// What it can do is decided by the server (the scopes attached to the scanned
// code), never by the query string — a code minted from the photo overlay
// carries photos only; the ICP and coral screens mint their own.

const MAX_EDGE = 2560

// Re-encode before uploading. Three wins: a 12 MP phone photo stops being a
// 5 MB upload over Wi-Fi, iOS hands us a JPEG for a HEIC original (Safari
// decodes HEIC natively, so the canvas does the conversion the Pi may not be
// able to), and the terminal stores something close to what it can display.
// Anything that fails here is uploaded untouched — the server tries again.
async function prepare(file) {
  const isHeic = /\.hei[cf]$/i.test(file.name)
  if (!file.type.startsWith('image/') && !isHeic) return file
  if (file.type === 'image/gif') return file // keep the animation
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Already small, already a JPEG: nothing to gain from re-encoding it.
    if (scale === 1 && !isHeic && file.type === 'image/jpeg' && file.size < 2_500_000) {
      bitmap.close?.()
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

function PhotoTab() {
  const [photos, setPhotos] = useState([])
  const [progress, setProgress] = useState(null)   // { done, total }
  const [result, setResult] = useState(null)       // { added, problems[] }
  const [error, setError] = useState(null)
  const fileInput = useRef(null)

  const load = () => api('/api/photos').then((d) => setPhotos(d.photos)).catch(() => {})
  useEffect(() => { load() }, [])

  const upload = async (event) => {
    const files = [...event.target.files]
    event.target.value = ''
    if (!files.length) return
    setError(null)
    setResult(null)
    setProgress({ done: 0, total: files.length })

    const problems = []
    let added = 0
    // One request per photo: a phone on Wi-Fi gets honest progress, and one
    // bad file can't take the whole batch down with it.
    for (const [i, file] of files.entries()) {
      try {
        const form = new FormData()
        form.append('photos', await prepare(file))
        const res = await fetch('/api/photos', { method: 'POST', headers: authHeaders(), body: form })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) problems.push(`${file.name}: ${data.error ?? 'upload failed'}`)
        else {
          added += data.uploaded?.length ?? 0
          for (const s of data.skipped ?? []) problems.push(`${s.name}: ${s.reason}`)
        }
      } catch (err) {
        problems.push(`${file.name}: ${err.message ?? 'upload failed'}`)
      }
      setProgress({ done: i + 1, total: files.length })
    }

    setProgress(null)
    setResult({ added, problems })
    load()
  }

  const remove = async (photo) => {
    try {
      await api(`/api/photos/${encodeURIComponent(photo.name)}`, { method: 'DELETE' })
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="phone-tab">
      <p className="phone-lead">
        Pictures added here rotate full-screen on the terminal whenever the display sits idle.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={upload}
      />
      <button className="phone-primary" onClick={() => fileInput.current?.click()} disabled={!!progress}>
        {progress ? `Uploading ${progress.done} of ${progress.total}…` : 'Choose photos'}
      </button>

      {result && (
        <div className="phone-result">
          {result.added > 0 && <div className="phone-ok">Added {result.added} photo{result.added === 1 ? '' : 's'}.</div>}
          {result.problems.map((p, i) => <div key={i} className="phone-problem">{p}</div>)}
        </div>
      )}
      {error && <div className="phone-problem">{error}</div>}

      <h2 className="phone-h2">On the terminal now · {photos.length}</h2>
      {!photos.length && <div className="phone-empty">No photos yet.</div>}
      <div className="phone-grid">
        {photos.map((p) => (
          <div key={p.name} className="phone-thumb">
            <img src={p.url} alt="" loading="lazy" />
            <button onClick={() => remove(p)} aria-label={`Remove ${p.name}`}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}


// Pasting a lab report. This is the one job that genuinely belongs on a phone:
// the PDF is already open on it, it has a real keyboard, and nobody is typing
// thirty elements into an on-screen one. The parser takes whatever shape the
// lab prints — "Calcium 412 mg/l", "Ca: 412", "Iodine,58,ug/l" — and reports
// back what it could not read rather than dropping it quietly.
function IcpTab() {
  const [paste, setPaste] = useState('')
  const [lab, setLab] = useState('')
  const [preview, setPreview] = useState(null)   // what the PDF turned out to say
  const [dropped, setDropped] = useState(() => new Set())
  const [dateStr, setDateStr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)

  const isoToday = () => new Date().toISOString().slice(0, 10)

  // A PDF is read but not saved. The paste path saves directly, because you
  // typed or copied those lines yourself and can see them; a PDF is a machine
  // reading a layout nobody checked, and a table whose columns did not survive
  // extraction produces plausible numbers on the wrong elements.
  const upload = async (file) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/log/icp/extract', { method: 'POST', headers: authHeaders(), body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'That PDF could not be read.')
      setPreview(data)
      setDropped(new Set())
      setDateStr(data.date ? new Date(data.date).toISOString().slice(0, 10) : isoToday())
    } catch (err) {
      setError(String(err.message ?? err))
    }
    setBusy(false)
  }

  const savePreview = async () => {
    const kept = preview.results.filter((r) => !dropped.has(r.element))
    setBusy(true)
    setError(null)
    try {
      const [y, m, d] = dateStr.split('-').map(Number)
      // Midday, so a date-only value cannot slide into the day before when it
      // is read back in a different timezone.
      const ts = new Date(y, m - 1, d, 12).getTime()
      const res = await api('/api/log/icp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts, lab: lab.trim() || null, results: kept })
      })
      setDone(res)
      setPreview(null)
      setPaste('')
    } catch (err) {
      setError(String(err.message ?? err))
    }
    setBusy(false)
  }

  const submitPaste = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api('/api/log/icp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paste, lab: lab.trim() || null })
      })
      setDone(res)
      setPaste('')
    } catch (err) {
      setError(String(err.message ?? err))
    }
    setBusy(false)
  }

  if (done) {
    const off = (done.results ?? []).filter((r) => r.status !== 'ok')
    return (
      <section className="phone-section">
        <h2 className="phone-h2">Added · {done.imported} elements</h2>
        {off.length === 0
          ? <p className="phone-lead">Everything came back inside its reference range.</p>
          : (
            <>
              <p className="phone-lead">{off.length} outside the reference range:</p>
              <ul className="phone-icp-flags">
                {off.map((r) => (
                  <li key={r.element} className={r.status}>
                    <b>{r.element}</b> {r.value} {r.unit} <em>{r.status}</em>
                  </li>
                ))}
              </ul>
            </>
          )}
        {done.skipped?.length > 0 && (
          <p className="phone-note">Could not read {done.skipped.length} line{done.skipped.length === 1 ? '' : 's'}: {done.skipped.join(' · ')}</p>
        )}
        <p className="phone-note">It is on the terminal now, in the ICP card.</p>
        <button className="phone-btn" onClick={() => setDone(null)}>Add another</button>
      </section>
    )
  }

  if (preview) {
    const kept = preview.results.filter((r) => !dropped.has(r.element))
    return (
      <section className="phone-section">
        <h2 className="phone-h2">Check this before it is saved</h2>
        <p className="phone-lead">
          {preview.results.length} elements read from {preview.file}. Tap any row that looks
          wrong to leave it out.
        </p>

        <label className="phone-field">
          <span>Sample date</span>
          <input className="phone-input" type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
        </label>
        <input
          className="phone-input"
          value={lab}
          onChange={(e) => setLab(e.target.value)}
          placeholder="Lab (ATI, Oceamo, Triton…)"
        />

        <ul className="phone-preview">
          {preview.results.map((r) => (
            <li
              key={r.element}
              className={`${r.status} ${dropped.has(r.element) ? 'dropped' : ''}`}
              onClick={() => setDropped((prev) => {
                const next = new Set(prev)
                next.has(r.element) ? next.delete(r.element) : next.add(r.element)
                return next
              })}
            >
              <b>{r.name}</b>
              <span className="phone-preview-val">
                {r.value}{r.belowLimit ? ' (below limit)' : ''} <em>{r.unit}</em>
              </span>
              {r.status !== 'ok' && <span className="phone-preview-flag">{r.status}</span>}
            </li>
          ))}
        </ul>

        {preview.skipped?.length > 0 && (
          <details className="phone-skipped">
            <summary>{preview.skipped.length} lines were not elements</summary>
            <ul>{preview.skipped.map((line, i) => <li key={i}>{line}</li>)}</ul>
          </details>
        )}

        {error && <div className="phone-error">{error}</div>}
        <button className="phone-btn" disabled={!kept.length || busy} onClick={savePreview}>
          {busy ? 'Saving…' : `Save ${kept.length} element${kept.length === 1 ? '' : 's'}`}
        </button>
        <button className="phone-btn ghost" onClick={() => { setPreview(null); setError(null) }}>Cancel</button>
      </section>
    )
  }

  return (
    <section className="phone-section">
      <h2 className="phone-h2">Add a lab report</h2>
      <p className="phone-lead">
        Upload the lab's PDF and it will be read for you — you get to check it before
        anything is saved.
      </p>
      <label className={`phone-btn file ${busy ? 'busy' : ''}`}>
        {busy ? 'Reading…' : 'Choose a PDF'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }}
        />
      </label>

      <h2 className="phone-h2">Or paste the numbers</h2>
      <p className="phone-lead">
        One element per line, however the lab prints it. Element name or symbol, then the
        number — units optional.
      </p>
      <input
        className="phone-input"
        value={lab}
        onChange={(e) => setLab(e.target.value)}
        placeholder="Lab (ATI, Oceamo, Triton…)"
      />
      <textarea
        className="phone-paste"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        rows={8}
        placeholder={'Calcium 412 mg/l\nMagnesium 1290\nStrontium (Sr) 8.4\nIodine, 58, ug/l\nCu <0.5'}
      />
      {error && <div className="phone-error">{error}</div>}
      <button className="phone-btn" disabled={!paste.trim() || busy} onClick={submitPaste}>
        {busy ? 'Reading…' : 'Add to the tank log'}
      </button>
    </section>
  )
}

// Photographing a coral. This is the tab that has to work one-handed, in
// front of the glass, with wet fingers: pick the coral, take the picture,
// done. Creating a new one is inline rather than a separate trip, because the
// moment you want to add a coral is the moment you are pointing at it.
function CoralTab() {
  const [corals, setCorals] = useState(null)
  const [picked, setPicked] = useState(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)

  const load = () => api('/api/corals').then((d) => setCorals(d.corals)).catch((err) => setError(String(err.message ?? err)))
  useEffect(() => { load() }, [])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const res = await api('/api/corals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      setNewName('')
      await load()
      setPicked({ id: res.id, name: res.name })
    } catch (err) {
      setError(String(err.message ?? err))
    }
    setBusy(false)
  }

  const upload = async (file) => {
    if (!file || !picked) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('photo', file)
      const res = await fetch(`/api/corals/${picked.id}/photos`, {
        method: 'POST', headers: authHeaders(), body: form
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'That photo could not be added.')
      setDone({ ...data, name: picked.name })
      await load()
    } catch (err) {
      setError(String(err.message ?? err))
    }
    setBusy(false)
  }

  if (done) {
    return (
      <section className="phone-section">
        <h2 className="phone-h2">Added to {done.name}</h2>
        <p className="phone-lead">It is on the terminal now, in the coral journal.</p>
        <button className="phone-btn" onClick={() => { setDone(null); setPicked(null) }}>Photograph another</button>
      </section>
    )
  }

  return (
    <section className="phone-section">
      <h2 className="phone-h2">{picked ? `Photographing ${picked.name}` : 'Which coral?'}</h2>

      {picked ? (
        <>
          <label className={`phone-btn file ${busy ? 'busy' : ''}`}>
            {busy ? 'Adding…' : 'Take a photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }}
            />
          </label>
          <label className="phone-btn ghost file">
            Choose one from the roll
            <input type="file" accept="image/*" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {error && <div className="phone-error">{error}</div>}
          <button className="phone-btn ghost" onClick={() => { setPicked(null); setError(null) }}>Pick a different coral</button>
        </>
      ) : (
        <>
          {corals === null && <p className="phone-lead">Loading…</p>}
          {corals?.length === 0 && <p className="phone-lead">Nothing in the journal yet. Name the first one below.</p>}
          <ul className="phone-corals">
            {(corals ?? []).map((c) => (
              <li key={c.id}>
                <button onClick={() => setPicked({ id: c.id, name: c.name })}>
                  {c.latest
                    ? <img src={`/coral-photos/${c.latest.file}`} alt="" loading="lazy" />
                    : <span className="phone-coral-blank" aria-hidden="true" />}
                  <span className="phone-coral-name">
                    <b>{c.name}</b>
                    <em>{c.photoCount ? `${c.photoCount} photo${c.photoCount === 1 ? '' : 's'}` : 'no photos yet'}</em>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <input
            className="phone-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New coral — what do you call it?"
          />
          {error && <div className="phone-error">{error}</div>}
          <button className="phone-btn" disabled={!newName.trim() || busy} onClick={create}>
            {busy ? 'Adding…' : 'Add it and take a photo'}
          </button>
        </>
      )}
    </section>
  )
}

export default function PhoneSetup() {
  const [session, setSession] = useState(null)
  const [expired, setExpired] = useState(false)
  const [tab, setTab] = useState(null)

  // Confirm the scanned code with the server (it decides the scopes), then keep
  // checking so a page left open on the counter tells the truth about itself.
  useEffect(() => {
    let cancelled = false
    const check = () => api('/api/setup/session')
      .then((d) => {
        if (cancelled) return
        setSession(d)
        setExpired(false)
        setTab((t) => t ?? (d.scopes.includes('photos') ? 'photos' : d.scopes[0]))
      })
      .catch(() => { if (!cancelled) setExpired(true) })
    check()
    const id = setInterval(check, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (expired) {
    return (
      <div className="phone">
        <div className="phone-card">
          <h1>Link expired</h1>
          <p className="phone-lead">
            For safety these codes only last half an hour. Tap the picture button on the
            terminal and scan the new one.
          </p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <div className="phone"><div className="phone-card"><p className="phone-lead">Connecting…</p></div></div>
  }

  const tabs = [
    ['photos', 'Photos'],
    ['icp', 'ICP'],
    ['corals', 'Corals']
  ].filter(([id]) => session.scopes.includes(id))

  return (
    <div className="phone">
      <div className="phone-card">
        <header className="phone-header">
          <img className="phone-logo" src="/brand/reefgauge-logo-600.png" alt="ReefGauge" />
          <span>connected to the display in your home</span>
        </header>
        {tabs.length > 1 && (
          <nav className="phone-tabs">
            {tabs.map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </nav>
        )}
        {tab === 'photos' && <PhotoTab />}
        {tab === 'icp' && <IcpTab />}
        {tab === 'corals' && <CoralTab />}
      </div>
    </div>
  )
}
