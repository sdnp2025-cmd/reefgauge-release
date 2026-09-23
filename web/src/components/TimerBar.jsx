import React, { useEffect, useState } from 'react'
import { api, usePolling } from '../api.js'

function fmt(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// Repeating chime while any timer has expired (kiosk runs Chromium with
// autoplay allowed; on phones the first tap unlocks audio).
function useChime(active) {
  useEffect(() => {
    if (!active) return
    let ctx
    try { ctx = new (window.AudioContext || window.webkitAudioContext)() } catch { return }
    const id = setInterval(() => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = 880
      gain.gain.value = 0.15
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.18)
    }, 700)
    return () => { clearInterval(id); ctx.close() }
  }, [active])
}

export function TimerBar() {
  const [data, refetch] = usePolling('/api/timers', 2000)
  const [, setTick] = useState(0)
  const timers = data?.timers ?? []

  useEffect(() => {
    if (!timers.length) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [timers.length])

  useChime(timers.some((t) => t.endsAt <= Date.now()))
  if (!timers.length) return null

  return (
    <div className="timer-bar">
      {timers.map((t) => {
        const remain = Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000))
        const done = remain === 0
        return (
          <button
            key={t.id}
            className={`timer-chip ${done ? 'done' : ''}`}
            onClick={async () => { await api(`/api/timers/${t.id}`, { method: 'DELETE' }); refetch() }}
          >
            ⏲️ {done ? "Time's up!" : fmt(remain)}{t.label ? ` · ${t.label}` : ''} <span className="timer-x">✕</span>
          </button>
        )
      })}
    </div>
  )
}

export function TimerPicker({ onClose }) {
  const start = async (minutes) => {
    await api('/api/timers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: minutes * 60 })
    })
    onClose()
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="timer-picker" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="month-title">⏲️ Set a timer</div>
          <div className="month-nav">
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="timer-presets">
          {[1, 5, 10, 15, 30, 60].map((m) => (
            <button key={m} className="timer-preset" onClick={() => start(m)}>
              {m >= 60 ? `${m / 60} hr` : `${m} min`}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
