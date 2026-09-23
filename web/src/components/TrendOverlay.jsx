import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { formatValue } from './TankPanel.jsx'

const W = 800
const H = 380
const M = { l: 64, r: 24, t: 24, b: 42 }
const WINDOWS = [
  { label: '24 H', hours: 24 },
  { label: '7 D', hours: 168 },
  { label: '30 D', hours: 720 }
]

function niceTicks(min, max, n = 4) {
  const span = max - min
  if (span <= 0) return [min]
  const mag = 10 ** Math.floor(Math.log10(span / n))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? span / n
  const out = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v)
  return out
}

function trendPerDay(points) {
  if (points.length < 2) return 0
  const t0 = points[0].ts
  const xs = points.map((p) => (p.ts - t0) / 86400000)
  const ys = points.map((p) => p.value)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den ? num / den : 0
}

export default function TrendOverlay({ paramKey, meta, onClose }) {
  const [hours, setHours] = useState(() => {
    const asked = Number(new URLSearchParams(location.search).get('hours'))
    return WINDOWS.some((w) => w.hours === asked) ? asked : 24
  })
  const [points, setPoints] = useState([])
  const [events, setEvents] = useState([])
  const [hover, setHover] = useState(null)
  const [markerHover, setMarkerHover] = useState(null)
  const svgRef = useRef(null)

  useEffect(() => {
    setHover(null)
    setMarkerHover(null)
    api(`/api/tank/history?param=${paramKey}&hours=${hours}`)
      .then((d) => setPoints(d.readings ?? []))
      .catch(() => setPoints([]))
    // What was done to the water, over the same window. A reading and the
    // reason for it have always been in two different places on this display;
    // this is the one chart where they can be in the same place.
    api(`/api/log/events?hours=${hours}`)
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setEvents([]))
  }, [paramKey, hours])

  const range = meta?.range
  const values = points.map((p) => p.value)
  const dataMin = values.length ? Math.min(...values) : range?.[0] ?? 0
  const dataMax = values.length ? Math.max(...values) : range?.[1] ?? 1
  const lo = Math.min(dataMin, range?.[0] ?? dataMin)
  const hi = Math.max(dataMax, range?.[1] ?? dataMax)
  const pad = (hi - lo || 1) * 0.15
  const yMin = lo - pad
  const yMax = hi + pad
  const t0 = points[0]?.ts ?? Date.now() - hours * 3600 * 1000
  const t1 = points[points.length - 1]?.ts ?? Date.now()

  const x = (ts) => M.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - M.l - M.r)
  const y = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * (H - M.t - M.b)

  const linePath = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const areaPath = points.length
    ? `${linePath} L ${x(t1).toFixed(1)} ${H - M.b} L ${x(t0).toFixed(1)} ${H - M.b} Z`
    : ''

  // Events land on the same axis as the readings, so they cluster the same
  // way: at 30 days a fortnight of daily dosing is thirty marks in the space
  // of a thumbnail. Anything closer than 12 units of the viewBox becomes one
  // marker that says how many it stands for.
  const markers = []
  for (const ev of events) {
    if (ev.ts < t0 || ev.ts > t1) continue          // outside the drawn axis
    const px = x(ev.ts)
    const last = markers[markers.length - 1]
    if (last && px - last.x < 12) {
      last.events.push(ev)
      last.hasWater = last.hasWater || ev.kind === 'water'
    } else {
      markers.push({ x: px, ts: ev.ts, events: [ev], hasWater: ev.kind === 'water' })
    }
  }

  // What a marker says when you touch it. One event says exactly what it was;
  // a cluster counts, because listing six doses in a tooltip is a list nobody
  // reads on a wall.
  const markerLabel = (m) => {
    if (m.events.length === 1) {
      const e = m.events[0]
      return [e.label, e.detail].filter(Boolean).join(' ')
    }
    const doses = m.events.filter((e) => e.kind === 'dose').length
    const parts = []
    if (m.hasWater) parts.push('Water change')
    if (doses) parts.push(`${doses} dose${doses === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  const slope = trendPerDay(points)
  const slopeAbs = Math.abs(slope)
  const flat = slopeAbs < (yMax - yMin) * 0.01
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

  const onMove = (e) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W

    // A marker within reach of the finger wins the tooltip: the reading is
    // already drawn as a line, and the event is the thing you came to check.
    let nearest = null
    let nearestD = 16
    markers.forEach((m, i) => {
      const d = Math.abs(m.x - px)
      if (d < nearestD) { nearestD = d; nearest = i }
    })
    setMarkerHover(nearest)

    if (!points.length) return
    let best = 0
    let bestD = Infinity
    points.forEach((p, i) => {
      const d = Math.abs(x(p.ts) - px)
      if (d < bestD) { bestD = d; best = i }
    })
    setHover(best)
  }

  const fmtTime = (ts) => hours <= 24
    ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: hours <= 168 ? 'numeric' : undefined })

  const hoverPoint = hover != null ? points[hover] : null

  // Rendered into <body> rather than where it sits in the tree. The tank panel
  // has a backdrop-filter for its frosted glass, and backdrop-filter creates a
  // stacking context — so a modal inside it is trapped there no matter what
  // z-index it claims. The view's own header was painting over this one's
  // title and window buttons, which made 7 D and 30 D untappable and the ✕
  // decorative.
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="trend-view" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="trend-title">
            <span className="trend-name">{meta?.label ?? paramKey}</span>
            <span className={`trend-current status-${meta?.status ?? 'unknown'}`}>
              {formatValue(paramKey, meta?.value)} {meta?.unit}
            </span>
            {range && <span className="trend-target">target {range[0]}–{range[1]}</span>}
          </div>
          <div className="month-nav">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                className={`trend-window ${hours === w.hours ? 'active' : ''}`}
                onClick={() => setHours(w.hours)}
              >{w.label}</button>
            ))}
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <svg
          ref={svgRef}
          className="trend-chart"
          viewBox={`0 0 ${W} ${H}`}
          onPointerMove={onMove}
          onPointerLeave={() => { setHover(null); setMarkerHover(null) }}
        >
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4cc3f7" stopOpacity="0.35" />
              <stop offset="1" stopColor="#4cc3f7" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {range && (
            <>
              <rect
                x={M.l} width={W - M.l - M.r}
                y={y(range[1])} height={Math.max(0, y(range[0]) - y(range[1]))}
                className="trend-band"
              />
              <line x1={M.l} x2={W - M.r} y1={y(range[0])} y2={y(range[0])} className="trend-band-edge" />
              <line x1={M.l} x2={W - M.r} y1={y(range[1])} y2={y(range[1])} className="trend-band-edge" />
            </>
          )}

          {niceTicks(yMin, yMax).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="trend-grid" />
              <text x={M.l - 10} y={y(v) + 4} className="trend-tick-y">{+v.toFixed(3)}</text>
            </g>
          ))}

          {[0, 1, 2, 3].map((i) => {
            const ts = t0 + ((t1 - t0) * i) / 3
            return (
              <text key={i} x={x(ts)} y={H - 14} className="trend-tick-x">{fmtTime(ts)}</text>
            )
          })}

          {/* Under the curve on purpose: the reading is what the chart is
              about, and a mark that obscures it has answered the wrong
              question. A water change gets the heavier line — it moves every
              parameter at once, where one dose moves one. */}
          {markers.map((m, i) => (
            <g key={m.ts} className={`trend-mark ${m.hasWater ? 'is-water' : 'is-dose'} ${markerHover === i ? 'on' : ''}`}>
              <line x1={m.x} x2={m.x} y1={M.t} y2={H - M.b} className="trend-mark-line" />
              {m.hasWater
                ? <path d={`M ${m.x} ${H - M.b - 11} l 6 11 h -12 Z`} className="trend-mark-glyph" />
                : <circle cx={m.x} cy={H - M.b - 4} r="4.5" className="trend-mark-glyph" />}
              {m.events.length > 1 && (
                <text x={m.x} y={H - M.b - 16} className="trend-mark-count" textAnchor="middle">
                  {m.events.length}
                </text>
              )}
            </g>
          ))}

          {areaPath && <path d={areaPath} fill="url(#trend-fill)" />}
          {linePath && <path d={linePath} className="trend-line" />}

          {hoverPoint && (
            <g>
              <line x1={x(hoverPoint.ts)} x2={x(hoverPoint.ts)} y1={M.t} y2={H - M.b} className="trend-cross" />
              <circle cx={x(hoverPoint.ts)} cy={y(hoverPoint.value)} r="6" className="trend-dot" />
              <text x={Math.min(Math.max(x(hoverPoint.ts), 110), W - 110)} y={16} className="trend-hover-label">
                {formatValue(paramKey, hoverPoint.value)} {meta?.unit} · {fmtTime(hoverPoint.ts)}
              </text>
            </g>
          )}

          {markerHover != null && markers[markerHover] && (() => {
            const m = markers[markerHover]
            const label = `${markerLabel(m)} · ${fmtTime(m.ts)}`
            // Estimated from the glyph width of the label's own type size:
            // measuring text inside SVG costs a layout pass per pointer move.
            const boxW = label.length * 7.4 + 22
            const boxX = Math.min(Math.max(m.x - boxW / 2, M.l), W - M.r - boxW)
            return (
              <g className="trend-mark-tip">
                <rect x={boxX} y={H - M.b - 44} width={boxW} height="26" rx="8" />
                <text x={boxX + boxW / 2} y={H - M.b - 26} textAnchor="middle">{label}</text>
              </g>
            )
          })()}

          {!points.length && (
            <text x={W / 2} y={H / 2} className="trend-empty">No history yet for this window</text>
          )}
        </svg>

        <div className="trend-stats">
          {markers.length > 0 && (
            <span className="trend-key">
              <svg viewBox="0 0 12 12" className="trend-key-dose" aria-hidden="true"><circle cx="6" cy="6" r="4.5" /></svg> dose
              <svg viewBox="0 0 12 12" className="trend-key-water" aria-hidden="true"><path d="M6 1.5 11 10.5H1Z" /></svg> water change
            </span>
          )}
          <span>Min <b>{values.length ? formatValue(paramKey, Math.min(...values)) : '—'}</b></span>
          <span>Avg <b>{avg != null ? formatValue(paramKey, avg) : '—'}</b></span>
          <span>Max <b>{values.length ? formatValue(paramKey, Math.max(...values)) : '—'}</b></span>
          <span className={`trend-slope ${flat ? '' : slope > 0 ? 'rising' : 'falling'}`}>
            {flat ? '→ stable' : `${slope > 0 ? '▲' : '▼'} ${+slopeAbs.toPrecision(2)} ${meta?.unit ?? ''}/day`}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
