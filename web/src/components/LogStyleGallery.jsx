import React from 'react'

// Design scratch pad: five treatments for the dosing and water-change gauges,
// each on its own shade of blue. Reachable at ?logstyles=1.
//
// Nothing here is wired into the Tank Log screen — this is a page to point at.
// The readings are representative rather than live, because a tank that had its
// water changed an hour ago pins every needle to the left and shows nothing.

const CX = 50
const CY = 52
const polar = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}
const arcPath = (r, a1, a2) => {
  const [x1, y1] = polar(r, a1)
  const [x2, y2] = polar(r, a2)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}
const angleFor = (frac) => -90 + 180 * Math.min(1, Math.max(0, frac))

const SAMPLES = [
  { label: 'Alkalinity', value: '10', unit: 'ml today', sub: '9.8 ml/day this week', frac: 0.52 },
  { label: 'Calcium', value: '0', unit: 'ml today', sub: '10 ml/day this week', frac: 0.02 },
  { label: 'Since the last one', value: '6', unit: 'days ago', sub: 'every 7 days', frac: 0.43, wide: true }
]

const Read = ({ s, tone }) => (
  <>
    <div className="lg-read"><b style={tone ? { color: tone } : undefined}>{s.value}</b><em>{s.unit}</em></div>
    <div className="lg-sub">{s.sub}</div>
  </>
)

// ── A. Gradient sweep ─────────────────────────────────────────────────────
// The dial itself is the colour: one band running cool to hot, needle over it.
function SweepGauge({ s }) {
  return (
    <div className="lg-tile lg-glass-light">
      <div className="lg-label">{s.label}</div>
      <svg viewBox="0 0 100 62">
        <defs>
          <linearGradient id="sweepGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#3b82f6" /><stop offset="0.45" stopColor="#22c07a" />
            <stop offset="0.75" stopColor="#f0b429" /><stop offset="1" stopColor="#e0524a" />
          </linearGradient>
        </defs>
        <path d={arcPath(34, -90, 90)} className="lg-sweep-track" />
        <path d={arcPath(34, -90, 90)} stroke="url(#sweepGrad)" className="lg-sweep-band" />
        {[-90, -45, 0, 45, 90].map((d) => {
          const [x1, y1] = polar(26, d); const [x2, y2] = polar(30, d)
          return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} className="lg-tick-light" />
        })}
        <g transform={`rotate(${angleFor(s.frac)} ${CX} ${CY})`}>
          <path d={`M ${CX} ${CY - 27} L ${CX - 3} ${CY} L ${CX + 3} ${CY} Z`} className="lg-needle-dark" />
        </g>
        <circle cx={CX} cy={CY} r="4" className="lg-hub-dark" />
      </svg>
      <Read s={s} />
    </div>
  )
}

// ── B. Neon fill ──────────────────────────────────────────────────────────
// A dark pane with one lit arc: the reading glows, everything else recedes.
function NeonGauge({ s }) {
  const len = Math.PI * 34
  return (
    <div className="lg-tile lg-glass-dark">
      <div className="lg-label lg-label-light">{s.label}</div>
      <svg viewBox="0 0 100 62">
        <defs>
          <linearGradient id="neonGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#4ade80" />
          </linearGradient>
        </defs>
        <path d={arcPath(34, -90, 90)} className="lg-neon-track" />
        {/* the glow is a fatter, fainter copy of the same arc — cheaper than a
            filter and it survives a Pi's compositor */}
        <path d={arcPath(34, -90, 90)} stroke="url(#neonGrad)" className="lg-neon-glow"
          strokeDasharray={`${(len * s.frac).toFixed(1)} ${len.toFixed(1)}`} />
        <path d={arcPath(34, -90, 90)} stroke="url(#neonGrad)" className="lg-neon-fill"
          strokeDasharray={`${(len * s.frac).toFixed(1)} ${len.toFixed(1)}`} />
        <circle {...(() => { const [x, y] = polar(34, angleFor(s.frac)); return { cx: x, cy: y } })()} r="4.5" className="lg-neon-dot" />
      </svg>
      <Read s={s} tone="#e8fbff" />
    </div>
  )
}

// ── C. Liquid dial ────────────────────────────────────────────────────────
// The gauge is a vial of tank water: the level is the reading, the dome is glass.
function LiquidGauge({ s }) {
  const top = 58 - s.frac * 44
  return (
    <div className="lg-tile lg-glass-aqua">
      <div className="lg-label">{s.label}</div>
      <svg viewBox="0 0 100 62">
        <defs>
          <clipPath id={`liq${s.label.replace(/\W/g, '')}`}>
            <circle cx={CX} cy="36" r="24" />
          </clipPath>
        </defs>
        <circle cx={CX} cy="36" r="24" className="lg-liquid-well" />
        <g clipPath={`url(#liq${s.label.replace(/\W/g, '')})`}>
          <rect x="20" y={top} width="60" height="60" fill="#3fb6d8" />
          <path d={`M20 ${top} q7 -4 15 0 t15 0 t15 0 t15 0 v8 H20 Z`} fill="#5fd0ea" />
        </g>
        <circle cx={CX} cy="36" r="24" className="lg-liquid-glass" />
        <ellipse cx="42" cy="26" rx="9" ry="5" className="lg-liquid-shine" transform="rotate(-28 42 26)" />
      </svg>
      <Read s={s} />
    </div>
  )
}

// ── D. Segments ───────────────────────────────────────────────────────────
// Discrete lit blocks, the way an instrument reads. Colour comes from position.
function SegmentGauge({ s }) {
  const N = 14
  const lit = Math.round(s.frac * N)
  const tone = (i) => (i / N < 0.35 ? '#3b82f6' : i / N < 0.72 ? '#22c07a' : i / N < 0.88 ? '#f0b429' : '#e0524a')
  return (
    <div className="lg-tile lg-glass-slate">
      <div className="lg-label lg-label-light">{s.label}</div>
      <svg viewBox="0 0 100 62">
        {Array.from({ length: N }, (_, i) => {
          const a = -90 + (180 * (i + 0.5)) / N
          const [x1, y1] = polar(24, a)
          const [x2, y2] = polar(36, a)
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={i < lit ? tone(i) : 'rgba(190, 215, 245, 0.16)'}
              className="lg-seg" />
          )
        })}
        <circle cx={CX} cy={CY} r="3.4" className="lg-hub-light" />
      </svg>
      <Read s={s} tone="#eaf4ff" />
    </div>
  )
}

// ── E. Instrument dial ────────────────────────────────────────────────────
// Painted zones on a dial face under a glass dome — a gauge off a machine.
function DialGauge({ s }) {
  return (
    <div className="lg-tile lg-glass-steel">
      <div className="lg-label">{s.label}</div>
      <svg viewBox="0 0 100 62">
        <path d={arcPath(30, -90, -34)} className="lg-zone" stroke="#3b82f6" />
        <path d={arcPath(30, -32, 40)} className="lg-zone" stroke="#22c07a" />
        <path d={arcPath(30, 42, 68)} className="lg-zone" stroke="#f0b429" />
        <path d={arcPath(30, 70, 90)} className="lg-zone" stroke="#e0524a" />
        {Array.from({ length: 21 }, (_, i) => {
          const a = -90 + i * 9
          const major = i % 5 === 0
          const [x1, y1] = polar(major ? 34 : 35.5, a)
          const [x2, y2] = polar(39, a)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? 'lg-tick-major' : 'lg-tick-minor'} />
        })}
        <g transform={`rotate(${angleFor(s.frac)} ${CX} ${CY})`}>
          <path d={`M ${CX} ${CY - 30} L ${CX - 2.6} ${CY + 4} L ${CX + 2.6} ${CY + 4} Z`} className="lg-needle-red" />
        </g>
        <circle cx={CX} cy={CY} r="4.5" className="lg-hub-steel" />
        <path d="M14 20 A 40 40 0 0 1 86 20 A 46 46 0 0 0 14 20 Z" className="lg-dome" />
      </svg>
      <Read s={s} />
    </div>
  )
}

const OPTIONS = [
  { id: 'sweep', name: 'Gradient sweep', note: 'The dial is the colour — cool to hot, needle over it. Panel: pale sky glass.', panel: 'lg-panel-sky', Gauge: SweepGauge },
  { id: 'neon', name: 'Neon fill', note: 'One lit arc on a dark pane; the reading glows and the rest recedes. Panel: deep navy.', panel: 'lg-panel-navy', Gauge: NeonGauge },
  { id: 'liquid', name: 'Liquid dial', note: 'The gauge is a vial of tank water with a glass dome. Panel: aqua.', panel: 'lg-panel-aqua', Gauge: LiquidGauge },
  { id: 'segments', name: 'Segments', note: 'Lit blocks, the way an instrument reads. Colour by position. Panel: slate blue.', panel: 'lg-panel-slate', Gauge: SegmentGauge },
  { id: 'dial', name: 'Instrument dial', note: 'Painted zones under a glass dome — a gauge off a machine. Panel: steel blue.', panel: 'lg-panel-steel', Gauge: DialGauge }
]

export default function LogStyleGallery() {
  return (
    <div className="lg-page">
      {OPTIONS.map(({ id, name, note, panel, Gauge }) => (
        <section key={id} className="lg-option">
          <div className={`panel lg-panel ${panel}`}>
            {SAMPLES.map((s) => <Gauge key={s.label} s={s} />)}
          </div>
          <div className="lg-caption"><b>{name}</b><span>{note}</span></div>
        </section>
      ))}
    </div>
  )
}
