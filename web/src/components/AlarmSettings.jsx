import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Choosing an alarm is the one setting nobody can get right by reading a
// description — "captivating" and "annoying" are the same sound at 3am. So
// every option plays here, on the speakers it will actually use, before it is
// chosen. Saving happens on the tap: there is no Save button to forget.

const S = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const PlayIcon = <svg {...S}><path d="M7 4.5v15l13-7.5z" /></svg>
const CheckIcon = <svg {...S}><path d="m5 13 4.5 4.5L19 7" /></svg>

const hourLabel = (h) => {
  const suffix = h < 12 ? 'am' : 'pm'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}${suffix}`
}

function ToneList({ sounds, value, onPick, onTest, testing }) {
  return (
    <div className="setup-list">
      {sounds.map((s) => (
        <div key={s.id} className={`setup-row alarm-row ${value === s.id ? 'selected' : ''}`}>
          <button className="alarm-pick" onClick={() => onPick(s.id)}>
            <span className="alarm-check">{value === s.id ? CheckIcon : null}</span>
            <span className="alarm-name">
              <b>{s.label}</b>
              <em>{s.note}</em>
            </span>
          </button>
          <button className="alarm-play" disabled={testing} onClick={() => onTest(s.id)} aria-label={`Hear ${s.label}`}>
            {PlayIcon}
          </button>
        </div>
      ))}
    </div>
  )
}

export default function AlarmSettings() {
  const [data, setData] = useState(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState(null)
  const [which, setWhich] = useState('urgent')

  useEffect(() => { api('/api/alerts/sounds').then(setData).catch((e) => setError(String(e.message ?? e))) }, [])

  const save = async (patch) => {
    setError(null)
    // Show the choice immediately; the server's answer is the record of truth
    // and replaces it a moment later.
    setData((d) => ({ ...d, ...patch }))
    try {
      const res = await api('/api/alerts/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      setData((d) => ({ ...d, ...res }))
      if (!res.persisted) setError('Saved for now, but this unit has no config file yet — finish setup to keep it.')
    } catch (err) {
      setError(String(err.message ?? err))
    }
  }

  const test = async (name) => {
    setTesting(true)
    setError(null)
    try {
      await api('/api/alerts/sounds/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
    } catch (err) {
      setError(String(err.message ?? err))
    }
    // The longest sound runs about three and a half seconds; the server plays
    // one at a time, so re-arming early would just give a dead-looking button.
    setTimeout(() => setTesting(false), 4000)
  }

  // A failed first load has to say so. "Loading…" that never resolves is the
  // same screen as a hung one, and the person waiting cannot tell them apart.
  if (!data) {
    return (
      <div className="setup-body">
        <h1>Alarms &amp; sounds</h1>
        {error ? <div className="setup-error">{error}</div> : <div className="setup-note">Loading…</div>}
      </div>
    )
  }

  const sounds = data.sounds ?? []
  const value = which === 'urgent' ? data.urgentTone : data.warningTone

  return (
    <div className="setup-body">
      <h1>Alarms & sounds</h1>

      <button className={`hub-toggle ${data.enabled ? 'on' : ''}`} onClick={() => save({ enabled: !data.enabled })}>
        <b>{data.enabled ? 'Alarm sounds are on' : 'Alarm sounds are off'}</b>
        <em>{data.enabled
          ? 'The panel speakers sound when something is wrong with the tank.'
          : 'Nothing will make a sound. The screen still shows alarms.'}</em>
      </button>

      <div className="alarm-tabs">
        <button className={which === 'urgent' ? 'on' : ''} onClick={() => setWhich('urgent')}>
          Urgent<em>{data.urgentTone}</em>
        </button>
        <button className={which === 'warning' ? 'on' : ''} onClick={() => setWhich('warning')}>
          Warning<em>{data.warningTone}</em>
        </button>
      </div>
      <p className="setup-note">
        {which === 'urgent'
          ? 'For a controller that stopped reporting, or a reading far out of range. Urgent alarms sound at any hour.'
          : 'For a reading drifting out of range. Warnings stay quiet overnight.'}
      </p>

      <ToneList
        sounds={sounds}
        value={value}
        testing={testing}
        onTest={test}
        onPick={(id) => save(which === 'urgent' ? { urgentTone: id } : { warningTone: id })}
      />

      <div className="alarm-steppers">
        <div className="alarm-stepper">
          <span>Quiet from</span>
          <button onClick={() => save({ quietFrom: (data.quietFrom + 23) % 24 })}>‹</button>
          <b>{hourLabel(data.quietFrom)}</b>
          <button onClick={() => save({ quietFrom: (data.quietFrom + 1) % 24 })}>›</button>
        </div>
        <div className="alarm-stepper">
          <span>until</span>
          <button onClick={() => save({ quietTo: (data.quietTo + 23) % 24 })}>‹</button>
          <b>{hourLabel(data.quietTo)}</b>
          <button onClick={() => save({ quietTo: (data.quietTo + 1) % 24 })}>›</button>
        </div>
        <div className="alarm-stepper">
          <span>Repeats for</span>
          <button onClick={() => save({ loopMinutes: Math.max(1, data.loopMinutes - 1) })}>‹</button>
          <b>{data.loopMinutes} min</b>
          <button onClick={() => save({ loopMinutes: Math.min(30, data.loopMinutes + 1) })}>›</button>
        </div>
      </div>

      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
