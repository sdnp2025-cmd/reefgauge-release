import React from 'react'
import { usePolling } from '../api.js'

// Design scratch pad: five ways the ICP card could carry the last test on the
// home screen, at the size it actually gets. Reachable at ?icpcards=1.
//
// The card it replaces is a list of four element symbols and the word HIGH.
// Everything here is trying to say the same thing with more life: how the tank
// came back, and which handful of numbers are the reason.

const COLOR = { ok: '#2fa96b', high: '#e0524a', low: '#3b82f6', unknown: '#94a3b8' }
const ORDER = { high: 0, low: 1, ok: 2 }

const fmt = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, ''))

function useLatest() {
  const [data] = usePolling('/api/log/icp?limit=1', 60000)
  const [series] = usePolling('/api/log/icp/series', 60000)
  const test = data?.tests?.[0] ?? null
  const results = (test?.results ?? []).slice().sort(
    (a, b) => (ORDER[a.status] - ORDER[b.status]) || a.element.localeCompare(b.element)
  )
  return { test, results, series: series?.series ?? [] }
}

const Shell = ({ name, note, className = '', children }) => (
  <figure className="icpc-figure">
    <div className={`home-card icpc-card ${className}`}>{children}</div>
    <figcaption><b>{name}</b><span>{note}</span></figcaption>
  </figure>
)

const Head = ({ children, right }) => (
  <div className="hc-head">
    <span className="hc-ico">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3h6" /><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3" />
      </svg>
    </span>
    <span className="hc-title">{children}</span>
    {right && <span className="icpc-when">{right}</span>}
  </div>
)

// ── 1. Score ring ─────────────────────────────────────────────────────────
// One number you can read across a room: how much of the test came back inside
// its band. The ring is the same shape as the tank gauges.
function ScoreRing({ results }) {
  const ok = results.filter((r) => r.status === 'ok').length
  const total = results.length || 1
  const frac = ok / total
  const C = 2 * Math.PI * 46
  const bad = results.filter((r) => r.status !== 'ok')
  const tone = frac > 0.85 ? COLOR.ok : frac > 0.6 ? '#e2a33d' : COLOR.high

  return (
    <Shell name="Score ring" note="One number, readable across a room">
      <Head right={`${bad.length} off`}>ICP</Head>
      <div className="icpc-ring-row">
        <svg viewBox="0 0 120 120" className="icpc-ring">
          <circle cx="60" cy="60" r="46" className="icpc-ring-track" />
          <circle
            cx="60" cy="60" r="46" className="icpc-ring-fill"
            stroke={tone}
            strokeDasharray={`${(C * frac).toFixed(1)} ${C.toFixed(1)}`}
            transform="rotate(-90 60 60)"
          />
          <text x="60" y="58" className="icpc-ring-num">{ok}<tspan className="icpc-ring-of">/{total}</tspan></text>
          <text x="60" y="76" className="icpc-ring-cap">in range</text>
        </svg>
        <ul className="icpc-worst">
          {bad.slice(0, 3).map((r) => (
            <li key={r.element}>
              <b style={{ color: COLOR[r.status] }}>{r.element}</b>
              <span>{fmt(r.value)}</span>
              <em style={{ color: COLOR[r.status] }}>{r.status === 'high' ? '▲' : '▼'}</em>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  )
}

// ── 2. Heatmap ────────────────────────────────────────────────────────────
// Every element at once, coloured by state. The eye reads the pattern before
// it reads any symbol — a mostly green block is a good test.
function Heatmap({ results }) {
  return (
    <Shell name="Heatmap" note="Every element at once; read the pattern, not the numbers">
      <Head right={`${results.filter((r) => r.status !== 'ok').length} off`}>ICP</Head>
      <div className="icpc-grid">
        {results.slice().sort((a, b) => a.element.localeCompare(b.element)).map((r) => (
          <span key={r.element} className="icpc-cell" style={{ background: COLOR[r.status] }}>
            {r.element}
          </span>
        ))}
      </div>
    </Shell>
  )
}

// ── 3. Skyline ────────────────────────────────────────────────────────────
// How far each element sits outside its band, up for too much and down for too
// little. The shape of the test, rather than its contents.
function Skyline({ results, series }) {
  const bySymbol = Object.fromEntries(series.map((s) => [s.element, s]))
  const bars = results.slice().sort((a, b) => a.element.localeCompare(b.element)).map((r) => {
    const ref = bySymbol[r.element]
    let dev = 0
    if (ref && ref.low != null && ref.high != null) {
      const span = (ref.high - ref.low) || ref.high || 1
      if (r.value > ref.high) dev = Math.min(1, (r.value - ref.high) / span)
      else if (r.value < ref.low) dev = -Math.min(1, (ref.low - r.value) / span)
    }
    return { element: r.element, dev, status: r.status }
  })
  const W = 300
  const H = 96
  const mid = H / 2
  const slot = W / bars.length

  return (
    <Shell name="Skyline" note="How far out, and which way — the shape of the test">
      <Head right={`${bars.filter((b) => b.dev !== 0).length} off`}>ICP</Head>
      <svg viewBox={`0 0 ${W} ${H}`} className="icpc-sky">
        <line x1="0" x2={W} y1={mid} y2={mid} className="icpc-sky-mid" />
        {bars.map((b, i) => {
          const h = Math.max(3, Math.abs(b.dev) * (mid - 12))
          return (
            <g key={b.element}>
              <rect
                x={i * slot + slot * 0.18} width={slot * 0.64}
                y={b.dev >= 0 ? mid - h : mid} height={h}
                rx="2" fill={COLOR[b.status]}
              />
              <text x={i * slot + slot / 2} y={H - 2} className="icpc-sky-label">{b.element}</text>
            </g>
          )
        })}
      </svg>
    </Shell>
  )
}

// ── 4. Spotlight ──────────────────────────────────────────────────────────
// One element at a time, big, with its own history under it. On the real card
// this would rotate through whatever is out of range.
function Spotlight({ results, series }) {
  const worst = results.find((r) => r.status !== 'ok') ?? results[0]
  const s = series.find((x) => x.element === worst?.element)
  const points = s?.points ?? []
  const others = results.filter((r) => r.status !== 'ok').length

  const W = 280
  const H = 54
  const values = points.map((p) => p.value)
  const min = Math.min(...values, s?.low ?? Infinity)
  const max = Math.max(...values, s?.high ?? -Infinity)
  const span = max - min || 1
  const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W)
  const y = (v) => H - ((v - min) / span) * (H - 8) - 4
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')

  return (
    <Shell name="Spotlight" note="One element, large, cycling through what is off">
      <Head right={others > 1 ? `1 of ${others}` : null}>ICP</Head>
      {worst && (
        <>
          <div className="icpc-spot">
            <span className="icpc-spot-sym" style={{ color: COLOR[worst.status] }}>{worst.element}</span>
            <span className="icpc-spot-val">{fmt(worst.value)}<em>{worst.unit}</em></span>
            <span className="icpc-spot-tag" style={{ background: COLOR[worst.status] }}>
              {worst.status === 'ok' ? 'in range' : worst.status}
            </span>
          </div>
          {points.length > 1 ? (
            <svg viewBox={`0 0 ${W} ${H}`} className="icpc-spark" preserveAspectRatio="none">
              {s?.low != null && (
                <rect x="0" y={y(s.high)} width={W} height={Math.max(2, y(s.low) - y(s.high))} className="icpc-spark-band" />
              )}
              <path d={line} fill="none" stroke={COLOR[worst.status]} strokeWidth="3" strokeLinecap="round" />
              <circle cx={x(points.length - 1)} cy={y(values[values.length - 1])} r="4.5" fill={COLOR[worst.status]} />
            </svg>
          ) : (
            // One test means no trend to draw. Rather than an empty chart, show
            // where the reading sits against the band it missed. Laid out in
            // HTML: a circle in a stretched SVG comes out an ellipse.
            (() => {
              const lo = s?.low ?? 0
              const hi = s?.high ?? worst.value
              const scale = Math.max(hi * 1.6, worst.value * 1.15, 1)
              const pct = (v) => `${Math.min(98, (v / scale) * 100)}%`
              return (
                <div className="icpc-pos">
                  <span className="icpc-pos-band" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
                  <span className="icpc-pos-dot" style={{ left: pct(worst.value), background: COLOR[worst.status] }} />
                </div>
              )
            })()
          )}
          <div className="icpc-spot-foot">
            {points.length > 1 ? `${points.length} tests` : 'first test — reference band shown'}
          </div>
        </>
      )}
    </Shell>
  )
}

// ── 5. Sample jar ─────────────────────────────────────────────────────────
// The tank's water in the vial that went to the lab, filled to how much came
// back in range. The most decorative of the five, and the most on-theme.
function SampleJar({ results }) {
  const ok = results.filter((r) => r.status === 'ok').length
  const total = results.length || 1
  const frac = ok / total
  const bad = results.filter((r) => r.status !== 'ok')
  const fillTop = 118 - frac * 82

  return (
    <Shell name="Sample jar" note="On-theme and decorative; the level is what came back clean" className="icpc-jar-card">
      <Head right={`${bad.length} off`}>ICP</Head>
      <div className="icpc-jar-row">
        <div className="icpc-jar-col">
        <svg viewBox="0 0 90 130" className="icpc-jar">
          <defs>
            <clipPath id="jarClip">
              <path d="M26 26h38v78a19 19 0 0 1-38 0Z" />
            </clipPath>
          </defs>
          <path d="M26 26h38v78a19 19 0 0 1-38 0Z" className="icpc-jar-glass" />
          <g clipPath="url(#jarClip)">
            <rect x="20" y={fillTop} width="50" height="120" fill="#3fb6d8" opacity="0.85" />
            <path d={`M20 ${fillTop} q12 -6 25 0 t25 0 v10 h-50 Z`} fill="#5fd0ea" opacity="0.9" />
            <circle cx="40" cy={fillTop + 26} r="3.5" fill="#dff6ff" opacity="0.75" />
            <circle cx="52" cy={fillTop + 44} r="2.5" fill="#dff6ff" opacity="0.6" />
            <circle cx="45" cy={fillTop + 62} r="2" fill="#dff6ff" opacity="0.5" />
          </g>
          <path d="M22 20h46v8H22z" className="icpc-jar-cap" />
        </svg>
        <div className="icpc-jar-pct">{Math.round(frac * 100)}%<em>clean</em></div>
        </div>
        <ul className="icpc-worst">
          {bad.slice(0, 4).map((r) => (
            <li key={r.element}>
              <b style={{ color: COLOR[r.status] }}>{r.element}</b>
              <span>{fmt(r.value)}</span>
              <em style={{ color: COLOR[r.status] }}>{r.status === 'high' ? '▲' : '▼'}</em>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  )
}

export default function IcpCardGallery() {
  const { results, series, test } = useLatest()

  if (!test) {
    return <div className="icpc-page"><p className="icpc-empty">No ICP test on this terminal to draw.</p></div>
  }

  return (
    <div className="icpc-page">
      <ScoreRing results={results} />
      <Heatmap results={results} />
      <Skyline results={results} series={series} />
      <Spotlight results={results} series={series} />
      <SampleJar results={results} />
    </div>
  )
}
