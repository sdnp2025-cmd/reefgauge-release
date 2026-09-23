import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Which dosing method the tank runs.
//
// It decides one thing: the bottles on the dosing screen. Naming them
// "Alkalinity, Calcium, Magnesium" is right for a two-part and wrong for
// everyone else — a Triton tank has four numbered parts, a Red Sea tank has A,
// B and C, and a Moonshiner has a shelf of trace elements and an ICP test
// telling them which one to move.

export default function DosingSettings() {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/api/log/dosing-method').then(setState).catch((err) => setError(String(err.message ?? err)))
  }, [])

  const choose = async (method) => {
    setError(null)
    const previous = state
    setState((s) => ({ ...s, method }))
    try {
      const res = await api('/api/log/dosing-method', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method })
      })
      if (!res.persisted) setError('Set for now, but this unit has no config file yet — finish setup to keep it.')
    } catch (err) {
      setState(previous)
      setError(String(err.message ?? err))
    }
  }

  if (!state && error) return <div className="setup-body"><h1>Dosing</h1><div className="setup-error">{error}</div></div>
  if (!state) return <div className="setup-body"><h1>Dosing</h1><div className="setup-note">Loading…</div></div>

  return (
    <div className="setup-body">
      <h1>Dosing</h1>
      <p>
        What you dose decides the bottles on the Chemistry screen. Anything you log by hand
        stays there too, whichever method is picked.
      </p>

      <div className="dose-method-grid">
        {state.methods.map((m) => (
          <button
            key={m.id}
            className={`dose-tile ${state.method === m.id ? 'selected' : ''}`}
            onClick={() => choose(m.id)}
            aria-pressed={state.method === m.id}
          >
            <b className="dose-tile-title">{m.title ?? m.name}</b>
            <em className="dose-tile-tag">{m.tagline ?? m.note}</em>
            {m.bottles.length > 0 && (
              <span className="dose-tile-bottles">
                {m.bottles.join(' · ')}{m.extra > 0 ? ` · +${m.extra} more` : ''}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
