import React, { useEffect, useRef, useState } from 'react'
import { api, usePolling } from '../api.js'
import { useDragScroll } from '../dragScroll.js'

// The coral journal. Every other screen here is a number; this is the one that
// answers "is it actually growing", which no parameter chart can.
//
// The first photo and the most recent one, side by side with the months
// between them, is the whole feature. Everything else on this screen is in
// service of getting that pair on the wall.

const DAY = 24 * 3600 * 1000

const S = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const Icon = {
  camera: <svg {...S}><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4Z" /><circle cx="12" cy="13" r="3.6" /></svg>,
  coral: <svg {...S}><path d="M12 21v-6" /><path d="M12 15c0-4-3-5-3-8" /><path d="M12 15c0-4 3-5 3-8" /><path d="M9 7a2 2 0 1 1 0-.1" /><path d="M15 7a2 2 0 1 1 0-.1" /><path d="M12 9a2.2 2.2 0 1 1 0-.1" /></svg>
}

const dateLabel = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

// The gap between two photos, said the way a person would say it.
function spanLabel(days) {
  if (days <= 0) return null
  if (days < 45) return `${days} days apart`
  if (days < 365) return `${Math.round(days / 30)} months apart`
  const years = days / 365
  return years < 1.9 ? 'a year apart' : `${Math.round(years)} years apart`
}

function Thumb({ photo, alt }) {
  if (!photo) {
    return <div className="coral-thumb empty" aria-hidden="true">{Icon.coral}</div>
  }
  return <img className="coral-thumb" src={`/coral-photos/${photo.file}`} alt={alt} loading="lazy" />
}

function CoralGrid({ corals, onOpen, onAdd }) {
  return (
    <div className="coral-grid">
      {corals.map((c) => (
        <button key={c.id} className="coral-card" onClick={() => onOpen(c.id)}>
          <Thumb photo={c.latest} alt={c.name} />
          <div className="coral-card-body">
            <b>{c.name}</b>
            <em>
              {c.photoCount === 0
                ? 'No photos yet'
                : `${c.photoCount} photo${c.photoCount === 1 ? '' : 's'}${spanLabel(c.spanDays) ? ` · ${spanLabel(c.spanDays)}` : ''}`}
            </em>
          </div>
        </button>
      ))}
      <button className="coral-card add" onClick={onAdd}>
        <div className="coral-thumb empty">{Icon.camera}</div>
        <div className="coral-card-body">
          <b>Add a coral</b>
          <em>from your phone</em>
        </div>
      </button>
    </div>
  )
}

function CoralDetail({ id, onBack, onChanged }) {
  const [data, setData] = useState(null)
  const [shown, setShown] = useState(null)   // index into photos, for the large view
  const [busy, setBusy] = useState(false)

  const load = () => api(`/api/corals/${id}`).then((d) => setData(d.coral)).catch(() => setData(false))
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (data === false) return <div className="panel coral-detail"><p className="hc-muted">That coral is gone.</p></div>
  if (!data) return <div className="panel coral-detail"><p className="hc-muted">Loading…</p></div>

  const photos = data.photos ?? []
  const first = photos[0]
  const latest = photos[photos.length - 1]
  const days = first && latest ? Math.round((latest.ts - first.ts) / DAY) : 0

  const removePhoto = async (photoId) => {
    setBusy(true)
    await api(`/api/corals/${id}/photos/${photoId}`, { method: 'DELETE' }).catch(() => {})
    setShown(null)
    await load()
    onChanged?.()
    setBusy(false)
  }

  const archive = async () => {
    setBusy(true)
    await api(`/api/corals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: !data.archived_at })
    }).catch(() => {})
    await load()
    onChanged?.()
    setBusy(false)
  }

  return (
    <div className="coral-detail">
      <div className="coral-detail-head">
        <button className="view-back" onClick={onBack}>‹ All corals</button>
        <div className="coral-detail-title">
          <b>{data.name}</b>
          <em>
            {[data.species, data.source, data.added_at ? `in the tank since ${dateLabel(data.added_at)}` : null]
              .filter(Boolean).join(' · ')}
          </em>
        </div>
        <button className="setup-skip" disabled={busy} onClick={archive}>
          {data.archived_at ? 'Bring back' : 'Archive'}
        </button>
      </div>

      {photos.length === 0 && (
        <div className="panel coral-empty">
          <p>No photos of this one yet. Scan the code on the previous screen and take one.</p>
        </div>
      )}

      {/* Then and now. With one photo there is no comparison to make, so it
          shows the single photo large rather than pretending to a pair. */}
      {photos.length > 0 && (
        <div className="panel coral-compare">
          {photos.length > 1 ? (
            <>
              <figure>
                <img src={`/coral-photos/${first.file}`} alt={`${data.name}, first photo`} />
                <figcaption>{dateLabel(first.ts)}</figcaption>
              </figure>
              <div className="coral-span">
                <b>{spanLabel(days) ?? 'same day'}</b>
                <em>{photos.length} photos</em>
              </div>
              <figure>
                <img src={`/coral-photos/${latest.file}`} alt={`${data.name}, latest photo`} />
                <figcaption>{dateLabel(latest.ts)}</figcaption>
              </figure>
            </>
          ) : (
            <figure className="only">
              <img src={`/coral-photos/${first.file}`} alt={data.name} />
              <figcaption>{dateLabel(first.ts)} · the first of many, hopefully</figcaption>
            </figure>
          )}
        </div>
      )}

      {photos.length > 1 && (
        <div className="coral-strip">
          {photos.map((p, i) => (
            <button key={p.id} className={`coral-strip-item ${shown === i ? 'on' : ''}`} onClick={() => setShown(i)}>
              <img src={`/coral-photos/${p.file}`} alt={dateLabel(p.ts)} loading="lazy" />
              <span>{new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            </button>
          ))}
        </div>
      )}

      {shown != null && photos[shown] && (
        <div className="overlay" onClick={() => setShown(null)}>
          <div className="coral-lightbox" onClick={(e) => e.stopPropagation()}>
            <img src={`/coral-photos/${photos[shown].file}`} alt={`${data.name}, ${dateLabel(photos[shown].ts)}`} />
            <div className="coral-lightbox-bar">
              <span>{dateLabel(photos[shown].ts)}</span>
              <button className="setup-skip" disabled={busy} onClick={() => removePhoto(photos[shown].id)}>Delete photo</button>
              <button className="month-close" onClick={() => setShown(null)} aria-label="Close">✕</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function CoralsView({ onBack }) {
  const [list, refetch] = usePolling('/api/corals', 60000)
  // ?view=corals&coral=3 opens one directly, the same way the trend charts and
  // the settings sections do.
  const [openId, setOpenId] = useState(() => {
    const asked = Number(new URLSearchParams(location.search).get('coral'))
    return Number.isInteger(asked) && asked > 0 ? asked : null
  })
  const [qr, setQr] = useState(null)
  const bodyRef = useRef(null)
  useDragScroll(bodyRef)

  const corals = list?.corals ?? []

  const showQr = async () => {
    setOpenId(null)
    try {
      setQr(await api('/api/setup/qr?scope=corals'))
    } catch (err) {
      setQr({ error: String(err.message ?? err) })
    }
  }

  return (
    <div className="view">
      <div className="view-bar">
        <button className="view-back" onClick={onBack}>‹ Home</button>
        <span className="view-title">Corals</span>
        <span className="view-action">
          <button className="view-btn" onClick={showQr}>Add from phone ›</button>
        </span>
      </div>

      <div className="view-body coral-body" ref={bodyRef}>
        {qr && (
          <div className="panel icp-qr">
            {qr.error ? <div className="setup-error">{qr.error}</div> : (
              <div className="setup-qr-row">
                <div className="setup-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
                <div className="setup-qr-text">
                  <b>Scan this at the tank.</b>
                  <br />Photograph a coral, pick which one it is, and it lands here.
                  <br /><span className="setup-note-inline">{qr.url}</span>
                  <br /><span className="setup-note-inline">The link stops working after {qr.expiresInMinutes} minutes.</span>
                </div>
              </div>
            )}
            <button className="setup-skip" onClick={() => { setQr(null); refetch() }}>Done</button>
          </div>
        )}

        {!qr && openId == null && corals.length === 0 && (
          <div className="panel coral-empty">
            <h2>Nothing in the journal yet</h2>
            <p>
              Photograph a coral from your phone every few weeks and this becomes the one
              record the controller cannot keep: the first photo and the latest one, side by
              side, with the months between them.
            </p>
            <button className="setup-primary" onClick={showQr}>Add the first one</button>
          </div>
        )}

        {!qr && openId == null && corals.length > 0 && (
          <CoralGrid corals={corals} onOpen={setOpenId} onAdd={showQr} />
        )}

        {!qr && openId != null && (
          <CoralDetail id={openId} onBack={() => { setOpenId(null); refetch() }} onChanged={refetch} />
        )}
      </div>
    </div>
  )
}
