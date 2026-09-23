import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, usePolling } from '../api.js'
import { arc, Ticks, Needle, CX, CY, R } from './TankPanel.jsx'
import { agoLabel } from './LogCards.jsx'
import { useDragScroll } from '../dragScroll.js'

// ICP results, read the way the tank's own parameters are read: a wall of
// meters you take in at a glance, and a chart when you want one element's
// history.
//
// The first version had this backwards — every element in a chip the size of a
// fingernail, and one chart permanently on screen. Thirty numbers are what you
// scan; a single element's trend is what you go looking for.
//
// Under each needle is the run of tests behind it, because a needle says where
// potassium is and the line says whether it is on its way somewhere. Tap for
// the same line at a readable size, over whichever window you want.

const DAY = 24 * 3600 * 1000

// Windows sized to how often people actually test — months, not days. null is
// every test on record.
const RANGES = [
  { id: 90, label: '3m' },
  { id: 180, label: '6m' },
  { id: 365, label: '1y' },
  { id: 730, label: '2y' },
  { id: null, label: 'All' }
]

const KIND_LABEL = { major: 'Dosed', minor: 'Seawater', trace: 'Trace', watch: 'Watch for' }
const KIND_NOTE = {
  major: 'consumed by the tank, put back by dosing',
  minor: 'present in seawater, rarely dosed',
  trace: 'wanted in small amounts',
  watch: 'no business being here in any quantity'
}

function fmt(v) {
  if (v == null) return '—'
  if (v >= 100) return Math.round(v).toString()
  if (v >= 10) return v.toFixed(1)
  if (v >= 1) return v.toFixed(2)
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

const shortDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
const longDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

function statusOf(series, value) {
  if (value == null) return 'unknown'
  if (series.low != null && value < series.low) return 'low'
  if (series.high != null && value > series.high) return 'high'
  return 'ok'
}

// The same three colours as everywhere else on the terminal: green inside
// the band, amber out of it by less than the band's own width, red beyond.
// Mirrors severityOf() on the server.
function severityOf(series, value) {
  if (value == null || series.low == null || series.high == null) return 'unknown'
  if (value >= series.low && value <= series.high) return 'ok'
  const span = (series.high - series.low) || series.high || 1
  const out = value < series.low ? series.low - value : value - series.high
  return out > span ? 'crit' : 'warn'
}

const inRange = (points, days) =>
  days == null ? points : points.filter((p) => p.ts >= Date.now() - days * DAY)

// Tests land when they land — one a fortnight, then nothing for half a year.
// Spacing the points evenly draws that gap as though it were a regular
// interval, which turns a stale reading into a trend. So x is time.
function timeScale(points, x0, w) {
  if (points.length < 2) return () => x0 + w / 2
  const first = points[0].ts
  const span = points[points.length - 1].ts - first
  if (span <= 0) return () => x0 + w / 2
  return (i) => x0 + ((points[i].ts - first) / span) * w
}

// The run of tests behind the needle, with the reference band drawn in so you
// can see whether it is heading into the band or out of it.
function SparkLine({ series, points }) {
  const W = 100
  const H = 30
  const cands = points.map((p) => p.value)
  if (series.low != null) cands.push(series.low)
  if (series.high != null) cands.push(series.high)
  let min = Math.min(...cands)
  let max = Math.max(...cands)
  if (min === max) { min -= 1; max += 1 }
  const pad = (max - min) * 0.16
  min -= pad
  max += pad

  const x = timeScale(points, 2, W - 4)
  const y = (v) => H - 3 - ((v - min) / (max - min)) * (H - 6)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const bandTop = series.high != null ? y(series.high) : null
  const bandBottom = series.low != null ? y(series.low) : null

  return (
    <svg className="icp-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {bandTop != null && bandBottom != null && (
        <rect x="0" y={bandTop} width={W} height={Math.max(1, bandBottom - bandTop)} className="icp-spark-band" />
      )}
      <path d={d} className="icp-spark-line" fill="none" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r="2.4" className="icp-spark-dot" />
    </svg>
  )
}

// The same face as a tank parameter: 180° of arc, the reference band as the
// middle third, the needle where this element sits. Built from TankPanel's own
// primitives so the two screens cannot drift apart.
// A drag that starts on a meter is a scroll, not a tap. Without the threshold
// below, trying to reach the bottom row opens whichever element your finger
// happened to land on.
const TAP_SLOP = 12

function ElementMeter({ series, onOpen }) {
  const down = React.useRef(null)
  const value = series.points[series.points.length - 1]?.value ?? null
  const status = statusOf(series, value)
  const severity = severityOf(series, value)

  let frac = null
  if (series.low != null && series.high != null && value != null) {
    const span = (series.high - series.low) || Math.max(series.high, 1)
    const min = series.low - span
    const max = series.high + span
    frac = Math.min(1, Math.max(0, (value - min) / (max - min)))
  }
  const angle = -90 + 180 * (frac ?? 0.5)

  return (
    <div
      className={`gauge icp-meter status-${status} sev-${severity}`}
      role="button"
      tabIndex={0}
      aria-label={`${series.name} history`}
      onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY } }}
      onPointerUp={(e) => {
        const start = down.current
        down.current = null
        if (!start) return
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= TAP_SLOP) onOpen()
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen() }}
    >
      <div className="gauge-label">
        <span>{series.name}</span>
        {status === 'high' && <span className="gauge-flag">▲ HIGH</span>}
        {status === 'low' && <span className="gauge-flag">▼ LOW</span>}
      </div>
      <svg viewBox="0 0 100 78">
        <path d={arc(R, -90, 90)} className="gauge-band" />
        <Ticks />
        {frac != null && <Needle angle={angle} />}
        <circle cx={CX} cy={CY} r="2.6" className="gauge-hub" />
        <text x={CX} y="66" className="gauge-value">{fmt(value)}</text>
        <text x={CX} y="75.5" className="gauge-sub">
          {series.unit}{series.low != null ? ` · ${fmt(series.low)}–${fmt(series.high)}` : ''}
        </text>
      </svg>
      {series.points.length > 1 ? (
        <div className="icp-spark-wrap">
          <SparkLine series={series} points={series.points.slice(-8)} />
          <span className="icp-spark-cap">{series.points.length} tests ›</span>
        </div>
      ) : (
        <span className="icp-spark-cap is-alone">one test so far</span>
      )}
    </div>
  )
}

// The QR sits over whatever opened it, because "add a test" is offered both
// from the header and from inside a chart, and the chart should still be
// there when the phone has finished with it.
function QrDialog({ qr, onClose }) {
  return createPortal(
    <div className="overlay qr-overlay" onClick={onClose}>
      <div className="qr-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="trend-title"><span className="trend-name">Add a test</span></div>
          <div className="month-nav">
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {qr.error ? <div className="setup-error">{qr.error}</div> : (
          <div className="setup-qr-row">
            <div className="setup-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <div className="setup-qr-text">
              <b>Scan this, then upload the lab's PDF.</b>
              <br />You get to check what it read before anything is saved.
              <br /><span className="setup-note-inline">{qr.url}</span>
              <br /><span className="setup-note-inline">The link stops working after {qr.expiresInMinutes} minutes.</span>
            </div>
          </div>
        )}
        <button className="setup-skip" onClick={onClose}>Done</button>
      </div>
    </div>,
    document.body
  )
}

// One element's history, on the dark ground every other chart here uses. The
// pastel panel this replaces put a thin violet line and grey labels on
// near-white glass, and washed out at any distance from the screen.
function ElementChart({ series, range, onRange, onAdd, onClose }) {
  const W = 900
  const H = 400
  const PAD = { top: 30, right: 110, bottom: 54, left: 88 }
  const points = inRange(series.points, range)

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const candidates = points.map((p) => p.value)
  if (series.low != null) candidates.push(series.low)
  if (series.high != null) candidates.push(series.high)
  let min = candidates.length ? Math.min(...candidates) : 0
  let max = candidates.length ? Math.max(...candidates) : 1
  if (min === max) { min -= 1; max += 1 }
  const pad = (max - min) * 0.15
  min -= pad
  max += pad
  // Anchor the axis at zero only when zero means something for this element —
  // a trace metal whose reference band starts there. Forcing it for calcium
  // squashed a reading that moved 341 to 428 into the top fifth of the chart,
  // which is the difference between a trend and a flat line.
  if (series.low === 0) min = 0
  else if (min < 0) min = 0

  const x = timeScale(points, PAD.left, plotW)
  const y = (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const area = points.length > 1
    ? `${line} L ${x(points.length - 1).toFixed(1)} ${PAD.top + plotH} L ${x(0).toFixed(1)} ${PAD.top + plotH} Z`
    : ''
  const last = points[points.length - 1]
  const bandTop = series.high != null ? y(series.high) : null
  const bandBottom = series.low != null ? y(series.low) : null
  const ticks = [min + (max - min) * 0.08, (min + max) / 2, max - (max - min) * 0.08]
  const status = statusOf(series, last?.value)
  const severity = severityOf(series, last?.value)

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="trend-view" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="trend-title">
            <span className="trend-name">{series.name}</span>
            <span className={`trend-current status-${status} sev-${severity}`}>{fmt(last?.value)} {series.unit}</span>
            {series.low != null && (
              <span className="trend-target">reference {fmt(series.low)}–{fmt(series.high)}</span>
            )}
          </div>
          <div className="month-nav">
            <button className="hist-log-btn" onClick={onAdd}>+ Add a test</button>
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="hist-ranges">
          {RANGES.map((r) => (
            <button
              key={String(r.id)}
              className={`hist-range${r.id === range ? ' is-on' : ''}`}
              onClick={() => onRange(r.id)}
              aria-pressed={r.id === range}
            >
              {r.label}
            </button>
          ))}
        </div>

        {points.length === 0 ? (
          <div className="hist-empty">No tests in this window.</div>
        ) : (
          <svg className="trend-chart" viewBox={`0 0 ${W} ${H}`} role="img"
            aria-label={`${series.name} across ${points.length} tests`}>
            <defs>
              <linearGradient id="icp-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4cc3f7" stopOpacity="0.34" />
                <stop offset="1" stopColor="#4cc3f7" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {bandTop != null && bandBottom != null && (
              <>
                <rect x={PAD.left} y={bandTop} width={plotW} height={Math.max(2, bandBottom - bandTop)} className="icp-band" />
                <line x1={PAD.left} x2={PAD.left + plotW} y1={bandTop} y2={bandTop} className="icp-band-edge" />
                <line x1={PAD.left} x2={PAD.left + plotW} y1={bandBottom} y2={bandBottom} className="icp-band-edge" />
              </>
            )}

            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="icp-grid" />
                <text x={PAD.left - 14} y={y(t) + 7} className="icp-tick" textAnchor="end">{fmt(t)}</text>
              </g>
            ))}

            {area && <path d={area} fill="url(#icp-fill)" />}
            <path d={line} className="icp-line" fill="none" />
            {points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.value)} r={i === points.length - 1 ? 9 : 6} className="icp-dot" />
            ))}

            {points.map((p, i) => (
              (points.length < 6 || i === 0 || i === points.length - 1) && (
                <text key={`d${i}`} x={x(i)} y={H - 18} className="icp-xlabel"
                  textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
                  {shortDate(p.ts)}
                </text>
              )
            ))}

            <text x={PAD.left + plotW + 16} y={y(last.value) - 6} className="icp-last">{fmt(last.value)}</text>
            <text x={PAD.left + plotW + 16} y={y(last.value) + 20} className="icp-unit">{series.unit}</text>
          </svg>
        )}

        {points.length > 0 && (
          <div className="trend-stats">
            <span>First <b>{fmt(points[0].value)}</b></span>
            <span>Latest <b>{fmt(last.value)}</b></span>
            <span>{points.length} test{points.length === 1 ? '' : 's'} · {longDate(points[0].ts)} to {longDate(last.ts)}</span>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default function IcpView({ onBack }) {
  const [data] = usePolling('/api/log/icp/series', 60000)
  const [tests] = usePolling('/api/log/icp?limit=1', 60000)
  // ?view=icp&element=Ca opens one element's history directly, the same way the
  // tank's ?trend= does.
  const bodyRef = useRef(null)
  useDragScroll(bodyRef)
  const [openElement, setOpenElement] = useState(
    () => new URLSearchParams(location.search).get('element') || null
  )
  const [range, setRange] = useState(null)
  const [qr, setQr] = useState(null)

  const series = data?.series ?? []
  const latest = tests?.tests?.[0] ?? null
  const current = series.find((s) => s.element === openElement) ?? null

  const showQr = async () => {
    try {
      setQr(await api('/api/setup/qr?scope=icp'))
    } catch (err) {
      setQr({ error: String(err.message ?? err) })
    }
  }

  // Out-of-band elements first inside their group, so the meters worth looking
  // at sit nearest the top of the screen.
  const grouped = ['major', 'minor', 'trace', 'watch'].map((kind) => ({
    kind,
    items: series
      .filter((s) => s.kind === kind)
      .sort((a, b) => {
        const rank = (s) => (statusOf(s, s.points[s.points.length - 1]?.value) === 'ok' ? 1 : 0)
        return rank(a) - rank(b) || a.element.localeCompare(b.element)
      })
  })).filter((g) => g.items.length)

  return (
    <div className="view">
      <div className="view-bar">
        <button className="view-back" onClick={onBack}>‹ Home</button>
        <span className="view-title">ICP results</span>
        <span className="view-action">
          {latest && <span className="view-meta">Last test {agoLabel(latest.ts)}</span>}
          <button className="view-btn" onClick={showQr}>Add a test ›</button>
        </span>
      </div>

      <div className="view-body icp-body" ref={bodyRef}>
        {series.length === 0 && (
          <div className="panel icp-empty">
            <h2>No ICP results yet</h2>
            <p>
              Upload a lab report from your phone and every element becomes a meter here, with
              its own history a tap away. ATI, Oceamo, Triton — whatever the lab prints.
            </p>
            <button className="setup-primary" onClick={showQr}>Add a test</button>
          </div>
        )}

        {grouped.map((group) => (
          <section key={group.kind} className="icp-group-block">
            <div className="icp-group-head">
              <h2>{KIND_LABEL[group.kind]}</h2>
              <span>{KIND_NOTE[group.kind]}</span>
            </div>
            <div className="icp-meters">
              {group.items.map((s) => (
                <ElementMeter key={s.element} series={s} onOpen={() => setOpenElement(s.element)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {current && current.points.length > 0 && (
        <ElementChart
          series={current}
          range={range}
          onRange={setRange}
          onAdd={showQr}
          onClose={() => setOpenElement(null)}
        />
      )}

      {qr && <QrDialog qr={qr} onClose={() => setQr(null)} />}
    </div>
  )
}
