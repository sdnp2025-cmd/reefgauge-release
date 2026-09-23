import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// What the screen does with itself once nobody has touched it for a while,
// and how long a while is. The intro loop is the default: it needs nothing
// added and it is the brand on the wall.
//
// The family-photo slideshow was the right answer when this was a family
// display. On a reef terminal the coral journal is the better one: those
// photos are of the thing the screen is bolted next to, and each carries the
// coral's name and the month it was taken — so an idle screen becomes a record
// of the tank rather than a picture frame that happens to be nearby.

// Minutes without a touch before the screensaver starts; 0 is never.
const DELAYS = [
  { minutes: 2, label: '2 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '60 min' },
  { minutes: 0, label: 'Off' }
]

const CHOICES = [
  {
    id: 'intro',
    title: 'The intro animation',
    note: 'The ReefGauge logo rising through the water, on a loop. Needs no photos.',
    count: () => null
  },
  {
    id: 'corals',
    title: 'The coral journal',
    note: 'Every photo in the journal, newest first, captioned with the coral and when it was taken.',
    count: (c) => c.corals
  },
  {
    id: 'photos',
    title: 'Family photos',
    note: 'Whatever has been sent to the terminal from a phone.',
    count: (c) => c.photos
  },
  {
    id: 'both',
    title: 'Both',
    note: 'Corals and family photos together.',
    count: (c) => c.corals + c.photos
  },
  {
    id: 'off',
    title: 'Nothing — leave the dashboard up',
    note: 'The tank stays on screen at all hours.',
    count: () => null
  }
]

export default function ScreensaverSettings() {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/api/slideshow/config').then(setState).catch((err) => setError(String(err.message ?? err)))
  }, [])

  // One saver for both settings: answer the tap now, let the server confirm,
  // and put it back the way it was if the server would not have it.
  const save = async (patch) => {
    setError(null)
    const previous = state
    setState((s) => ({ ...s, ...patch }))
    try {
      const res = await api('/api/slideshow/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      if (!res.persisted) setError('Set for now, but this unit has no config file yet — finish setup to keep it.')
    } catch (err) {
      setState(previous)
      setError(String(err.message ?? err))
    }
  }
  const choose = (source) => save({ source })
  const chooseDelay = (idleMinutes) => save({ idleMinutes })

  if (!state && error) return <div className="setup-body"><h1>Screensaver</h1><div className="setup-error">{error}</div></div>
  if (!state) return <div className="setup-body"><h1>Screensaver</h1><div className="setup-note">Loading…</div></div>

  const counts = state.counts ?? { photos: 0, corals: 0 }
  const idle = state.idleMinutes ?? 5

  return (
    <div className="setup-body">
      <h1>Screensaver</h1>
      <p>
        {idle === 0
          ? 'The screensaver is off — the dashboard stays up until it is switched back on.'
          : `After ${idle} minute${idle === 1 ? '' : 's'} without a touch, the screen shows this instead of the dashboard.`}
      </p>

      <div className="saver-delay">
        <span className="saver-delay-label">Start after</span>
        <div className="saver-chips" role="radiogroup" aria-label="Start the screensaver after">
          {DELAYS.map((d) => (
            <button
              key={d.minutes}
              role="radio"
              aria-checked={idle === d.minutes}
              className={`saver-chip ${idle === d.minutes ? 'selected' : ''}`}
              onClick={() => chooseDelay(d.minutes)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`setup-list saver-list ${idle === 0 ? 'saver-list-off' : ''}`}>
        {CHOICES.map((c) => {
          const n = c.count(counts)
          return (
            <button
              key={c.id}
              className={`setup-row saver-row ${state.source === c.id ? 'selected' : ''}`}
              onClick={() => choose(c.id)}
            >
              <span className="saver-text">
                <b>{c.title}</b>
                <em>{c.note}</em>
              </span>
              {/* Says what it has to show. Choosing a source with nothing in it
                  leaves a blank screensaver, and finding that out at 11pm is
                  worse than being told here. */}
              {n != null && (
                <span className={`setup-row-meta ${n === 0 ? 'saver-none' : ''}`}>
                  {n === 0 ? 'nothing yet' : `${n} photo${n === 1 ? '' : 's'}`}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {state.source === 'corals' && counts.corals === 0 && (
        <div className="setup-note">
          The journal is empty, so the screen will stay on the dashboard until a coral is
          photographed. Chemistry → Corals.
        </div>
      )}

      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
