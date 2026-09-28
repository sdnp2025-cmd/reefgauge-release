import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { GAUGE_ORDER, LONG, fmtVal } from './HomeCards.jsx'

// Saying what each thing plugged into the Apex actually measures.
//
// Setup works this out on its own and is right for a Trident every time, so
// most people will never open this. It exists for everything else, and for one
// case in particular: a KH monitor whose output is a pH-electrode signal
// carrying the alkalinity number. The Apex reports that as a pH input, so
// unless it happens to be named "Alk" it gets adopted as the tank's pH, and the
// wall shows a pH of 8.2 that is really 8.2 dKH. It looks completely normal.
//
// Live values are shown against every input for the same reason a plumber puts
// a hand on the pipe: the reliable way to tell which probe is which is to see
// what each one currently reads.

const SOURCE_LABEL = { aquawiz: 'AquaWiz', ekoral: 'Ekoral' }

// Offered only for alkalinity, because that is the only parameter these devices
// carry on somebody else's input type.
const KH_DEVICES = [
  { id: 'aquawiz', label: 'AquaWiz', hint: 'KH monitor, connected by BNC to a pH input' },
  { id: 'ekoral', label: 'Ekoral', hint: 'KH monitor, connected by BNC to a pH input' }
]

export default function ApexInputs() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(null)   // which parameter is being set

  const load = () => api('/api/apex/inputs')
    .then(setData)
    .catch((e) => setError(String(e.message ?? e)))

  useEffect(() => { load() }, [])

  const assign = async (param, inputName, source) => {
    setBusy(true); setError(null)
    try {
      await api('/api/apex/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ param, inputName, source: source ?? null })
      })
      await load()
      setPicking(null)
    } catch (e) {
      setError(String(e.message ?? e))
    } finally { setBusy(false) }
  }

  if (error && !data) return <div className="setup-error">{error}</div>
  if (!data) return <div className="setup-note">Loading…</div>

  if (!data.configured) {
    return (
      <div className="setup-body">
        <h1>Tank probes</h1>
        <p className="setup-note">
          No Apex controller is set up on this terminal, so there are no probes to assign.
        </p>
      </div>
    )
  }

  const inputs = data.inputs ?? []
  const byName = (n) => inputs.find((i) => i.name === n)

  // ---- picking an input for one parameter ----------------------------------
  if (picking) {
    const current = data.mapping?.[picking]
    // Which inputs are already spoken for, so the same probe is not silently
    // assigned to two things. Still offered, but marked.
    const takenBy = {}
    for (const [p, n] of Object.entries(data.mapping ?? {})) if (n && p !== picking) takenBy[n] = p

    return (
      <div className="setup-body apex-inputs">
        <h1>{LONG[picking]}</h1>
        <p className="setup-note">
          Which input on the Apex is measuring this? The current reading is shown beside each
          one — that is the surest way to tell them apart.
        </p>

        <div className="ai-list">
          <button className={`ai-row ${current == null ? 'on' : ''}`}
                  disabled={busy} onClick={() => assign(picking, null)}>
            <span className="ai-name">Nothing measures this</span>
            <span className="ai-meta">the gauge stays empty</span>
          </button>

          {inputs.map((i) => (
            <button key={i.name} className={`ai-row ${current === i.name ? 'on' : ''}`}
                    disabled={busy} onClick={() => assign(picking, i.name)}>
              <span className="ai-name">{i.name}</span>
              <span className="ai-meta">
                {i.type ? `${i.type} · ` : ''}reads {i.value ?? '—'}
                {takenBy[i.name] ? ` · already used for ${LONG[takenBy[i.name]]}` : ''}
              </span>
            </button>
          ))}
        </div>

        {picking === 'alk' && current && (
          <>
            <h2>Where does this reading come from?</h2>
            <p className="setup-note">
              A KH monitor sends its reading as a pH signal down a BNC cable, so the Apex
              reports it as a pH input. Saying so here only changes what the terminal calls it —
              the number is used exactly the same way.
            </p>
            <div className="ai-list">
              <button className={`ai-row ${!data.sources?.alk ? 'on' : ''}`}
                      disabled={busy} onClick={() => assign('alk', current, null)}>
                <span className="ai-name">The Apex measures it</span>
                <span className="ai-meta">a Trident, or a probe wired straight in</span>
              </button>
              {KH_DEVICES.map((d) => (
                <button key={d.id} className={`ai-row ${data.sources?.alk === d.id ? 'on' : ''}`}
                        disabled={busy} onClick={() => assign('alk', current, d.id)}>
                  <span className="ai-name">{d.label}</span>
                  <span className="ai-meta">{d.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <button className="setup-primary" onClick={() => setPicking(null)}>Done</button>
        {error && <div className="setup-error">{error}</div>}
      </div>
    )
  }

  // ---- the list of parameters ----------------------------------------------
  return (
    <div className="setup-body apex-inputs">
      <h1>Tank probes</h1>
      <p className="setup-note">
        The terminal worked these out from the Apex when it was set up. Change one if a reading
        is showing up in the wrong place.
      </p>

      {data.error && <p className="cal-flag">The Apex is not answering: {data.error}</p>}

      <div className="ai-list">
        {GAUGE_ORDER.filter((p) => data.params.includes(p)).map((param) => {
          const name = data.mapping?.[param]
          const input = name ? byName(name) : null
          const source = data.sources?.[param]
          return (
            <button key={param} className="ai-row" disabled={busy} onClick={() => setPicking(param)}>
              <span className="ai-name">{LONG[param]}</span>
              <span className="ai-meta">
                {name == null
                  ? 'Not set'
                  : !input
                    // A mapping pointing at an input the Apex no longer reports is
                    // why a gauge goes blank, and it is invisible everywhere else.
                    ? `${name} — the Apex is no longer reporting this input`
                    : <>
                        {name} · {fmtVal(param, input.value)}
                        {source ? ` · via ${SOURCE_LABEL[source] ?? source}` : ''}
                      </>}
              </span>
            </button>
          )
        })}
      </div>

      <p className="setup-note">
        Changes take effect on the next reading from the Apex, within a minute.
      </p>
      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
