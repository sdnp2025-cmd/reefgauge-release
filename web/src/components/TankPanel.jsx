import React, { useEffect, useState } from 'react'
import { api, usePolling } from '../api.js'
import TrendOverlay from './TrendOverlay.jsx'

const ORDER = ['temp', 'ph', 'salinity', 'alk', 'ca', 'mg', 'no3', 'po4']

export function formatValue(key, value) {
  if (value == null) return '—'
  if (key === 'po4' || key === 'ph') return value.toFixed(2)
  if (key === 'alk' || key === 'temp' || key === 'salinity' || key === 'no3') {
    return value.toFixed(1)
  }
  return Math.round(value).toString()
}

const FLAGS = { low: '▼ LOW', high: '▲ HIGH' }

// Speedometer: 180° arc, continuous red→amber→green→amber→red gradient so the
// green apex is the target band and both extremes run hot. The displayed span
// is the target range padded by one range-width per side (thirds).
export const CX = 50
export const CY = 47
export const R = 33

function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}

export function arc(r, a1, a2) {
  const [x1, y1] = polar(r, a1)
  const [x2, y2] = polar(r, a2)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

export function Ticks() {
  const ticks = []
  for (let deg = -90; deg <= 90; deg += 9) {
    const major = deg === -90 || deg === -30 || deg === 30 || deg === 90
    const [x1, y1] = polar(major ? R - 5 : R - 3.4, deg)
    const [x2, y2] = polar(major ? R + 5 : R + 3.4, deg)
    ticks.push(
      <line
        key={deg}
        x1={x1.toFixed(2)} y1={y1.toFixed(2)}
        x2={x2.toFixed(2)} y2={y2.toFixed(2)}
        className={major ? 'gauge-tick major' : 'gauge-tick'}
      />
    )
  }
  return <>{ticks}</>
}

export function Needle({ angle }) {
  const [tx, ty] = polar(R - 6, angle)
  const [b1x, b1y] = polar(2, angle + 100)
  const [b2x, b2y] = polar(2, angle - 100)
  return (
    <polygon
      points={`${tx.toFixed(2)},${ty.toFixed(2)} ${b1x.toFixed(2)},${b1y.toFixed(2)} ${b2x.toFixed(2)},${b2y.toFixed(2)}`}
      className="gauge-needle"
      filter="url(#glow-white)"
    />
  )
}

function Gauge({ paramKey, p, onOpen }) {
  const range = p?.range
  const value = p?.value
  let frac = null
  if (range && value != null) {
    const span = range[1] - range[0]
    const min = range[0] - span
    const max = range[1] + span
    frac = Math.min(1, Math.max(0, (value - min) / (max - min)))
  }
  const angle = -90 + 180 * (frac ?? 0.5)
  const status = p?.status ?? 'unknown'

  return (
    <div className={`gauge status-${status}`} onClick={onOpen} role="button" aria-label={`${p?.label ?? paramKey} trend`}>
      <div className="gauge-label">
        <span>{p?.label ?? paramKey}</span>
        {FLAGS[status] && <span className="gauge-flag">{FLAGS[status]}</span>}
      </div>
      <svg viewBox="0 0 100 78">
        <path d={arc(R, -90, 90)} className="gauge-band" />
        <Ticks />
        {frac != null && <Needle angle={angle} />}
        <circle cx={CX} cy={CY} r="2.6" className="gauge-hub" />
        <text x={CX} y="66" className="gauge-value">{formatValue(paramKey, value)}</text>
        <text x={CX} y="75.5" className="gauge-sub">
          {p?.unit ? `${p.unit} · ` : ''}{range ? `${range[0]}–${range[1]}` : ''}
        </text>
      </svg>
    </div>
  )
}

// Feed-mode button: starts the Apex feed cycle, shows the countdown while
// pumps are paused.
export function FeedButton() {
  const [feedUntil, setFeedUntil] = useState(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    api('/api/tank/latest').then((d) => setFeedUntil(d.feedUntil)).catch(() => {})
  }, [])

  const active = feedUntil && feedUntil > Date.now()
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [active])

  const start = async () => {
    try {
      const res = await api('/api/tank/feed', { method: 'POST' })
      setFeedUntil(res.feedUntil)
    } catch { /* Apex unreachable — button stays idle */ }
  }

  if (active) {
    const remain = Math.max(0, Math.ceil((feedUntil - Date.now()) / 1000))
    return (
      <span className="feed-btn feeding">
        🍤 Feeding · {Math.floor(remain / 60)}:{String(remain % 60).padStart(2, '0')}
      </span>
    )
  }
  return <button className="feed-btn" onClick={start}>🍤 Feed</button>
}

export default function TankPanel() {
  const [data] = usePolling('/api/tank/latest', 30000)
  // ?trend=alk opens straight onto one parameter's history — the same reason
  // ?view= exists: something complaining about a reading can send you to the
  // chart of that reading rather than to the screen it lives on.
  const [trendKey, setTrendKey] = useState(() => {
    const asked = new URLSearchParams(location.search).get('trend')
    return asked || null
  })
  const params = data?.params ?? {}

  return (
    <>
      {/* shared gradient + glow defs referenced by every gauge */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff5a4e" />
            <stop offset="0.2" stopColor="#ffc14d" />
            <stop offset="0.4" stopColor="#43e08f" />
            <stop offset="0.6" stopColor="#43e08f" />
            <stop offset="0.8" stopColor="#ffc14d" />
            <stop offset="1" stopColor="#ff5a4e" />
          </linearGradient>
          <filter id="glow-white" x="-80%" y="-80%" width="260%" height="260%">
            <feDropShadow dx="0" dy="0" stdDeviation="1.4" floodColor="#ffffff" floodOpacity="0.8" />
          </filter>
        </defs>
      </svg>
      <div className="gauge-grid">
        {ORDER.map((key) => (
          <Gauge key={key} paramKey={key} p={params[key]} onOpen={() => setTrendKey(key)} />
        ))}
      </div>
      {data?.error && <div className="error-note">Apex offline: {data.error}</div>}
      {trendKey && (
        <TrendOverlay paramKey={trendKey} meta={params[trendKey]} onClose={() => setTrendKey(null)} />
      )}
    </>
  )
}
