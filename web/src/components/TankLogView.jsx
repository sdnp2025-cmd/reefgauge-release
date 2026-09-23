import React, { useMemo, useState } from 'react'
import { api, usePolling } from '../api.js'
import HistoryChart from './HistoryChart.jsx'
import Keypad from './Keypad.jsx'
import { agoLabel } from './LogCards.jsx'

// Dosing and water changes.
//
// Each bottle is a dial you tap, and tapping one asks how much — a keypad, not
// a preset button, because "10 ml" is a guess about a tank and the amount is
// the one thing only the person standing there knows. The dial is a vial of
// tank water: the level is the reading, the dome is glass.
//
// Beside each dial is the last week as bars, because a dial answers "did I
// dose today" and the bars answer "have I been keeping it up" — which is the
// question a reef actually cares about. Tap through for the same bars over a
// longer window.

const DAY = 24 * 3600 * 1000

// null is the whole log.
const RANGES = [
  { id: 7, label: '7d' },
  { id: 30, label: '30d' },
  { id: 60, label: '60d' },
  { id: 90, label: '90d' },
  { id: null, label: 'All' }
]

function when(ts) {
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return today ? `Today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

const ml = (v) => (v == null ? '—' : v >= 10 ? Math.round(v).toString() : String(Math.round(v * 10) / 10))

const midnight = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }

// Daily totals with the empty days filled back in. The server only stores the
// days something went in, and bars drawn straight from those close the gaps —
// drawing a routine that never faltered. A missed day is the whole point.
//
// Stepped with setDate rather than by adding milliseconds, so the clocks going
// back does not shift every bar by an hour and start merging them.
function daily(points, days) {
  const totals = new Map((points ?? []).map((p) => [midnight(p.ts), p.value]))
  const end = new Date(); end.setHours(0, 0, 0, 0)
  const cur = new Date(end)
  if (days == null) {
    if (points?.length) cur.setTime(midnight(points[0].ts))
  } else {
    cur.setDate(cur.getDate() - (days - 1))
  }
  const out = []
  while (cur <= end) {
    out.push({ ts: cur.getTime(), value: totals.get(cur.getTime()) ?? 0 })
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

// Past a few months there are more days than pixels, so the bars become weeks.
const WEEKLY_ABOVE = 120

function bars(points, days) {
  const d = daily(points, days)
  if (d.length <= WEEKLY_ABOVE) return { points: d, weekly: false }
  const weeks = []
  for (let i = 0; i < d.length; i += 7) {
    const chunk = d.slice(i, i + 7)
    weeks.push({
      ts: chunk[0].ts,
      value: Math.round(chunk.reduce((a, p) => a + p.value, 0) * 10) / 10
    })
  }
  return { points: weeks, weekly: true }
}

// The last week beside the dial: seven bars, one per day, zeroes included.
function SparkBars({ points }) {
  const max = Math.max(1, ...points.map((p) => p.value))
  const w = 100 / points.length
  return (
    <svg className="liq-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      {points.map((p, i) => {
        const h = p.value > 0 ? Math.max(3, (p.value / max) * 30) : 1.5
        return (
          <rect
            key={p.ts}
            x={i * w + w * 0.16}
            y={33 - h}
            width={w * 0.68}
            height={h}
            className={`liq-bar${p.value > 0 ? '' : ' is-zero'}${i === points.length - 1 ? ' is-last' : ''}`}
          />
        )
      })}
      <line x1="0" x2="100" y1="34" y2="34" className="liq-spark-base" />
    </svg>
  )
}

// The liquid dial. A well of water in a glass disc, filled to the reading.
//
// The whole tile opens the history, and logging a dose is a button on the
// history. One target on a wet touchscreen beats two, and the graph is the
// right place to be standing when you decide what to put in.
function LiquidDial({ label, value, unit, sub, frac, tone, spark, onOpen }) {
  const level = 68 - Math.min(1, Math.max(0, frac ?? 0)) * 62
  const id = label.replace(/\W/g, '')
  return (
    <div className="liq-tile" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen() }}
      aria-label={`${label}, ${value} ${unit}`}>
      <div className="liq-label">{label}</div>
      <div className={`liq-mid${spark ? '' : ' is-solo'}`}>
        <svg className="liq-dial" viewBox="0 0 72 72" aria-hidden="true">
          <defs>
            <clipPath id={`liq-${id}`}><circle cx="36" cy="36" r="31" /></clipPath>
          </defs>
          <circle cx="36" cy="36" r="31" className="liq-well" />
          <g clipPath={`url(#liq-${id})`}>
            <rect x="0" y={level} width="72" height="72" fill={tone ?? '#3fb6d8'} />
            <path d={`M0 ${level} q5 -3 10 0 t10 0 t10 0 t10 0 t10 0 t10 0 t12 0 v10 H0 Z`}
              fill={tone ? '#7fe0f2' : '#5fd0ea'} opacity="0.9" />
            <circle cx="27" cy={level + 15} r="3" fill="#e6fbff" opacity="0.7" />
            <circle cx="45" cy={level + 26} r="2.1" fill="#e6fbff" opacity="0.55" />
          </g>
          <circle cx="36" cy="36" r="31" className="liq-glass" />
          <ellipse cx="26" cy="21" rx="10" ry="5.5" className="liq-shine" transform="rotate(-28 26 21)" />
        </svg>
        {spark && (
          <div className="liq-spark-wrap">
            <SparkBars points={spark} />
            <span className="liq-spark-cap">7 days ›</span>
          </div>
        )}
      </div>
      <div className="liq-read"><b>{value}</b><em>{unit}</em></div>
      <div className="liq-sub">{sub}</div>
    </div>
  )
}

function DoseColumn() {
  const [presets, refetchPresets] = usePolling('/api/log/supplements', 5 * 60 * 1000)
  // The whole log, so switching the chart's range never waits on the network.
  const [series, refetchSeries] = usePolling('/api/log/doses/series?days=all', 30000)
  const [doses, refetchDoses] = usePolling('/api/log/doses?days=all', 30000)
  const [entering, setEntering] = useState(null)   // {name, amountMl}
  const [picking, setPicking] = useState(false)
  const [history, setHistory] = useState(null)
  const [range, setRange] = useState(7)
  const [error, setError] = useState(null)

  const refetch = () => { refetchDoses(); refetchSeries(); refetchPresets() }

  const commit = async (supplement, amountMl) => {
    setError(null)
    try {
      await api('/api/log/doses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplement, amountMl })
      })
      setEntering(null)
      refetch()
    } catch (err) {
      setError(String(err.message ?? err))
    }
  }

  const remove = async (id) => {
    await api(`/api/log/doses/${id}`, { method: 'DELETE' }).catch(() => {})
    refetch()
  }

  const bottles = presets?.supplements ?? []
  const more = presets?.more ?? []
  const stats = Object.fromEntries((series?.series ?? []).map((e) => [e.supplement, e]))

  // One week of bars per bottle, rebuilt only when the numbers change.
  const sparks = useMemo(() => {
    const out = {}
    for (const e of series?.series ?? []) out[e.supplement] = daily(e.points, 7)
    return out
  }, [series])

  const current = history ? (series?.series ?? []).find((e) => e.supplement === history) : null
  const chart = current ? bars(current.points, range) : null
  const since = range == null ? 0 : Date.now() - range * DAY
  const currentDoses = (doses?.doses ?? []).filter((d) => d.supplement === history && d.ts >= since)

  return (
    <div className="panel log-col log-col-water">
      <div className="log-col-head">
        <h2 className="log-col-title">Dosing</h2>
        {more.length > 0 && (
          <button className="log-more-btn" onClick={() => setPicking(true)}>+ another bottle</button>
        )}
      </div>

      {error && <div className="setup-error">{error}</div>}

      <div className="liq-grid">
        {bottles.map((b) => {
          const s = stats[b.name]
          const today = s?.todayMl ?? 0
          const avg = s?.avg7 ?? 0
          // The well fills against the seven-day average, so a normal day is
          // about half full and a missed one is visibly empty.
          const frac = avg > 0 ? today / (avg * 2) : today > 0 ? 0.5 : 0
          return (
            <LiquidDial
              key={b.name}
              label={b.name}
              value={ml(today)}
              unit="ml today"
              sub={avg > 0 ? `${ml(avg)} ml/day this week` : 'not dosed yet'}
              frac={frac}
              spark={sparks[b.name] ?? daily([], 7)}
              onOpen={() => { setRange(7); setHistory(b.name) }}
            />
          )
        })}
      </div>

      {picking && (
        <div className="overlay" onClick={() => setPicking(false)}>
          <div className="bottle-picker" onClick={(e) => e.stopPropagation()}>
            <div className="keypad-head">
              <div className="keypad-title"><b>Which bottle?</b><em>everything else your method knows about</em></div>
              <button className="month-close" onClick={() => setPicking(false)} aria-label="Close">✕</button>
            </div>
            <div className="bottle-list">
              {more.map((b) => (
                <button key={b.name} onClick={() => { setPicking(false); setEntering({ name: b.name, amountMl: b.amountMl }) }}>
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {current && (
        <HistoryChart
          title={current.supplement}
          subtitle={
            `${ml(current.avg7)} ml/day over the last week · last dosed ${agoLabel(current.lastTs)}` +
            (chart.weekly ? ' · bars are weekly totals' : '')
          }
          unit="ml"
          points={chart.points}
          ranges={RANGES}
          range={range}
          onRange={setRange}
          action={
            <button className="hist-log-btn" onClick={() => setEntering({
              name: current.supplement,
              amountMl: bottles.find((b) => b.name === current.supplement)?.amountMl ?? current.avg7 ?? null
            })}>
              + Log a dose
            </button>
          }
          onClose={() => setHistory(null)}
        >
          {currentDoses.map((d) => (
            <div key={d.id} className="hist-row">
              <span className="log-when">{when(d.ts)}</span>
              <span className="log-amount">{d.amount_ml != null ? `${d.amount_ml} ml` : ''}</span>
              <button className="log-del" onClick={() => remove(d.id)} aria-label="Delete this dose">×</button>
            </div>
          ))}
        </HistoryChart>
      )}

      {entering && (
        <Keypad
          title={entering.name}
          subtitle="How much went in?"
          unit="ml"
          initial={entering.amountMl}
          onCommit={(v) => commit(entering.name, v)}
          onClose={() => setEntering(null)}
        />
      )}
    </div>
  )
}

function WaterColumn() {
  const [water, refetch] = usePolling('/api/log/water?limit=60', 60000)
  const changes = water?.changes ?? []
  const interval = water?.intervalDays ?? 7
  const [entering, setEntering] = useState(false)
  const [history, setHistory] = useState(false)
  const [error, setError] = useState(null)

  const last = changes[0]
  const daysSince = last ? (Date.now() - last.ts) / DAY : null
  const frac = daysSince == null ? 1 : Math.min(1, daysSince / interval)
  const due = daysSince != null && daysSince >= interval

  const usual = changes.length
    ? Math.round((changes.reduce((a, c) => a + (c.gallons ?? 0), 0) / changes.length) * 10) / 10
    : 10

  const commit = async (gallons) => {
    setError(null)
    try {
      await api('/api/log/water', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gallons, salt: last?.salt ?? null })
      })
      setEntering(false)
      refetch()
    } catch (err) {
      setError(String(err.message ?? err))
    }
  }

  const remove = async (id) => {
    await api(`/api/log/water/${id}`, { method: 'DELETE' }).catch(() => {})
    refetch()
  }

  const points = [...changes].reverse().map((c) => ({ ts: c.ts, value: c.gallons ?? 0 }))

  return (
    <div className="panel log-col log-col-side">
      <div className="log-col-head">
        <h2 className="log-col-title">Water</h2>
        {changes.length > 0 && (
          <button className="log-more-btn" onClick={() => setHistory(true)}>history</button>
        )}
      </div>

      {error && <div className="setup-error">{error}</div>}

      <div className="liq-grid liq-grid-single">
        <LiquidDial
          label="Last change"
          value={daysSince == null ? '—' : Math.floor(daysSince)}
          unit={daysSince != null && Math.floor(daysSince) === 1 ? 'day ago' : 'days ago'}
          sub={`every ${interval} days`}
          frac={frac}
          tone={due ? '#e08a3f' : undefined}
          onOpen={() => setEntering(true)}
        />
      </div>

      <div className="log-water-note">
        {last
          ? <><b>{last.gallons ?? '—'} gal</b> {agoLabel(last.ts)}{usual ? ` · usually ${usual}` : ''}</>
          : 'None logged yet — tap to record one.'}
      </div>
      <p className="log-note">Logging one here also ticks the maintenance task.</p>

      {entering && (
        <Keypad
          title="Water change"
          subtitle="How many gallons?"
          unit="gal"
          initial={usual}
          onCommit={commit}
          onClose={() => setEntering(false)}
        />
      )}

      {history && (
        <HistoryChart
          title="Water changes"
          subtitle={`${changes.length} logged · every ${interval} days`}
          unit="gal"
          points={points}
          target={usual}
          onClose={() => setHistory(false)}
        >
          {changes.map((c, i) => {
            const prev = changes[i + 1]
            const gap = prev ? Math.round((c.ts - prev.ts) / DAY) : null
            return (
              <div key={c.id} className="hist-row">
                <span className="log-when">{when(c.ts)}</span>
                <span className="log-what">{c.salt ?? 'Water change'}</span>
                <span className="log-amount">
                  {c.gallons ? `${c.gallons} gal` : ''}{gap != null ? ` · ${gap}d later` : ''}
                </span>
                <button className="log-del" onClick={() => remove(c.id)} aria-label="Delete water change">×</button>
              </div>
            )
          })}
        </HistoryChart>
      )}
    </div>
  )
}

export default function TankLogView({ onBack, onOpen }) {
  const [log] = usePolling('/api/log/summary', 60000)
  const last = log?.lastWaterChange
  return (
    <div className="view">
      <div className="view-bar">
        <button className="view-back" onClick={onBack}>‹ Home</button>
        <span className="view-title">Chemistry</span>
        <span className="view-action">
          {last && <span className="view-meta">Last water change {agoLabel(last.ts)}</span>}
          <button className="view-btn" onClick={() => onOpen?.('corals')}>Corals ›</button>
        </span>
      </div>
      <div className="view-body log-body">
        <DoseColumn />
        <WaterColumn />
      </div>
    </div>
  )
}
