import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import Keypad from './Keypad.jsx'
import { testedAgo } from './TankPanel.jsx'

// Log a test done by hand: pick what was tested, type the number.
//
// Eight tiles, each with what it read last and how long ago, so the screen
// answers "what is due?" before anything is tapped. A tile turns amber when
// its last test is older than that parameter is usually tested; that is a
// nudge, not an alarm.

const ORDER = ['alk', 'ca', 'mg', 'no3', 'po4', 'salinity', 'ph', 'temp']
const DAY = 86400000
const fmt = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100))
const when = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })

export default function TestLog({ onClose }) {
  const [data, setData] = useState(null)
  const [entering, setEntering] = useState(null)   // parameter key
  const [error, setError] = useState(null)

  const load = () => api('/api/tests').then(setData).catch((e) => setError(String(e.message ?? e)))
  useEffect(() => { load() }, [])

  const commit = async (value) => {
    setError(null)
    try {
      await api('/api/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ param: entering, value })
      })
      setEntering(null)
      load()
    } catch (err) {
      // The keypad closes so the reason can be read; the tile is one tap away.
      setEntering(null)
      setError(String(err.message ?? err))
    }
  }

  const remove = async (id) => {
    await api(`/api/tests/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  const params = data?.params ?? {}
  const keys = ORDER.filter((k) => params[k])
  const meta = entering ? params[entering] : null

  return createPortal(
    <div className="overlay tests-overlay" onClick={onClose}>
      <div className="tests-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="tests-head">
          <div>
            <b>Log a test</b>
            <em>Tap what you tested and enter the result.</em>
          </div>
          <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div className="setup-error">{error}</div>}

        <div className="tests-grid">
          {keys.map((k) => {
            const last = data.latest?.[k]
            const due = !last || (Date.now() - last.ts) / DAY >= params[k].everyDays
            return (
              <button key={k} className={`tests-tile ${last && due ? 'due' : ''}`} onClick={() => { setError(null); setEntering(k) }}>
                <span className="tests-name">{params[k].label}</span>
                <span className="tests-value">{fmt(last?.value)}<small>{last ? params[k].unit : ''}</small></span>
                <span className="tests-when">{last ? `tested ${testedAgo(last.ts)}` : 'not tested yet'}</span>
              </button>
            )
          })}
        </div>

        {data?.recent?.length > 0 && (
          <div className="tests-recent">
            {data.recent.map((r) => (
              <div key={r.id} className="hist-row">
                <span className="log-when">{when(r.ts)}</span>
                <span className="log-what">{params[r.param]?.label ?? r.param}</span>
                <span className="log-amount">{fmt(r.value)} {params[r.param]?.unit ?? ''}</span>
                <button className="log-del" onClick={() => remove(r.id)} aria-label="Delete this test">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {entering && meta && (
        <div onClick={(e) => e.stopPropagation()}>
          <Keypad
            title={meta.label}
            subtitle="What did the test read?"
            unit={meta.unit}
            initial={data.latest?.[entering]?.value}
            allowZero
            onCommit={commit}
            onClose={() => setEntering(null)}
          />
        </div>
      )}
    </div>,
    document.body
  )
}
