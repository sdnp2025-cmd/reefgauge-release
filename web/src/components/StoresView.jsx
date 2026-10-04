import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { DetailView } from './Views.jsx'

// Fish stores near the tank. The list the terminal keeps is a week old at
// most; tapping a store shows its hours for the week and a code the customer
// scans for directions on their phone - the wall is not where you navigate from.

const G = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'view-glyph' }
const StoreGlyph = () => (
  <svg {...G}><path d="M3 9.5 5 4h14l2 5.5" /><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12v8h14v-8" /><path d="M10 20v-5h4v5" /></svg>
)

const miles = (km) => (km == null ? '' : km < 0.16 ? 'here' : `${(km * 0.621371).toFixed(km * 0.621371 < 10 ? 1 : 0)} mi`)

function todayLine(hours) {
  if (!hours?.length) return null
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const today = names[new Date().getDay()]
  const line = hours.find((h) => h.startsWith(today))
  return line ? line.replace(`${today}: `, '') : null
}

function StoreRow({ store, selected, onPick }) {
  const today = todayLine(store.hours)
  return (
    <button className={`store-row ${selected ? 'selected' : ''}`} onClick={onPick}>
      <div className="store-main">
        <b className="store-name">{store.name}</b>
        <span className="store-addr">{store.address ?? ''}</span>
      </div>
      <div className="store-side">
        <span className="store-dist">{miles(store.km)}</span>
        {store.open === true && <span className="store-chip open">Open now</span>}
        {store.open === false && <span className="store-chip closed">Closed</span>}
        {today && <span className="store-today">{today}</span>}
      </div>
    </button>
  )
}

function StoreDetail({ store }) {
  return (
    <div className="store-detail">
      <h2>{store.name}</h2>
      {store.address && <p className="store-detail-addr">{store.address}</p>}
      <div className="store-facts">
        {store.phone && <span className="store-fact"><b>{store.phone}</b></span>}
        {store.rating != null && (
          <span className="store-fact">{store.rating.toFixed(1)} ★{store.ratings ? ` · ${store.ratings} reviews` : ''}</span>
        )}
        {store.km != null && <span className="store-fact">{miles(store.km)} away</span>}
      </div>
      {store.hours?.length ? (
        <ul className="store-hours">
          {store.hours.map((h) => {
            const [day, ...rest] = h.split(': ')
            const today = h.startsWith(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()])
            return <li key={h} className={today ? 'today' : ''}><span>{day}</span><span>{rest.join(': ')}</span></li>
          })}
        </ul>
      ) : <p className="hc-muted">Hours not listed.</p>}
      {store.maps && (
        <div className="store-qr-row">
          <img className="store-qr" src={`/api/stores/${encodeURIComponent(store.id)}/qr.svg`} alt="" draggable="false" />
          <span className="store-qr-text">Scan with your phone for directions and the store's page.</span>
        </div>
      )}
    </div>
  )
}

export default function StoresView({ onBack }) {
  const [data, setData] = useState(null)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = (refresh) => {
    setBusy(true)
    api(`/api/stores${refresh ? '?refresh=1' : ''}`).then(setData).catch((e) => setData({ stores: [], error: String(e.message ?? e) })).finally(() => setBusy(false))
  }
  useEffect(() => { load(false) }, [])

  const stores = data?.stores ?? []
  const current = stores.find((s) => s.id === picked) ?? stores[0]

  return (
    <DetailView
      title={<><StoreGlyph /> Fish stores near you</>}
      onBack={onBack}
      action={<button className="view-btn" onClick={() => load(true)} disabled={busy}>{busy ? 'Looking…' : 'Refresh'}</button>}
    >
      <div className="panel stores-panel">
        {data == null && <p className="hc-muted">Finding stores near the tank…</p>}
        {data?.error && stores.length === 0 && <p className="hc-muted">{data.error}</p>}
        {stores.length > 0 && (
          <div className="stores-split">
            <div className="stores-list">
              {stores.map((s) => (
                <StoreRow key={s.id} store={s} selected={current?.id === s.id} onPick={() => setPicked(s.id)} />
              ))}
              {data?.at && (
                <p className="stores-note">
                  Listed by distance from the tank. Checked {new Date(data.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}.
                  {data.error ? ` Could not refresh: ${data.error}` : ''}
                </p>
              )}
            </div>
            {current && <StoreDetail store={current} />}
          </div>
        )}
        {data && !data.error && stores.length === 0 && <p className="hc-muted">No saltwater stores found within about 30 miles of the tank.</p>}
      </div>
    </DetailView>
  )
}
