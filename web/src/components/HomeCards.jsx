import React, { useMemo } from 'react'
import { useEnvironment } from '../environment.js'
import WeatherCard from './WeatherCard.jsx'
import { TankLogCard } from './LogCards.jsx'
import { usePolling } from '../api.js'

// The 10" home screen: the tank on the left, two-thirds of the width, with
// every parameter as a ring and its last day as a line; weather, room air and
// the tank's written history stacked on the right. One big thing, three
// small ones. Each card keeps its own colour family so the eye can find it.

function tankSummary(data) {
  const params = data?.params ?? {}
  const critical = []
  const issues = []
  for (const p of Object.values(params)) {
    if (p.value == null || !p.range) continue
    const span = p.range[1] - p.range[0]
    if (p.value < p.range[0] - span || p.value > p.range[1] + span) critical.push(p)
    else if (p.status === 'low' || p.status === 'high') issues.push(p)
  }
  return { params, issues, critical }
}

export const GAUGE_ORDER = ['temp', 'ph', 'salinity', 'alk', 'ca', 'mg', 'no3', 'po4']
export const SHORT = { temp: 'Temp', ph: 'pH', salinity: 'Salt', alk: 'Alk', ca: 'Ca', mg: 'Mg', no3: 'NO₃', po4: 'PO₄' }
export const LONG = { temp: 'Temperature', ph: 'pH', salinity: 'Salinity', alk: 'Alkalinity', ca: 'Calcium', mg: 'Magnesium', no3: 'Nitrate', po4: 'Phosphate' }
const DECIMALS = { temp: 1, ph: 2, salinity: 1, alk: 1, ca: 0, mg: 0, no3: 1, po4: 2 }

export function fmtVal(key, v) {
  if (v == null) return '—'
  const d = DECIMALS[key] ?? 1
  return (+v).toFixed(d).replace(/\.0$/, '')
}

// Small SVG icons for the card titles (consistent stroke style, no emoji)
const Icon = {
  fish: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 12c1.8-3.2 5-5 8.5-5 2.5 0 4.8 1 6.5 2.7-1.7 4-5 6.3-8.5 6.3-2.5 0-4.8-1-6.5-2.7z" /><path d="M6.5 12 2 8.5v7z" /><circle cx="16.5" cy="11" r="0.6" fill="currentColor" /></svg>
  ),
  wind: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.6 4.6A2 2 0 1 1 11 8H2" /><path d="M12.6 19.4A2 2 0 1 0 14 16H2" /><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" /></svg>
  ),
  flag: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5l7 12H5z" /></svg>
  ),
  flagDown: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-12H5z" /></svg>
  )
}

// A day of readings as one polyline, with the target band behind it. Drawn
// once per poll and otherwise static: it is a picture, not an animation.
export function Spark({ points, range, status, width = 100, height = 28 }) {
  if (!points || points.length < 2) return <svg className="hc-spark" viewBox={`0 0 ${width} ${height}`} />
  const vals = points.map((p) => p.value)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (range) { lo = Math.min(lo, range[0]); hi = Math.max(hi, range[1]) }
  const pad = (hi - lo) * 0.12 || 1
  lo -= pad; hi += pad
  const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * width
  const y = (v) => height - ((v - lo) / (hi - lo)) * height
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <svg className={`hc-spark is-${status}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {range && <rect className="hc-spark-band" x="0" y={y(range[1])} width={width} height={Math.max(1, y(range[0]) - y(range[1]))} />}
      <path className="hc-spark-line" d={d} fill="none" vectorEffect="non-scaling-stroke" />
      {/* A zero-length round-capped stroke: a dot that stays round under the
          non-uniform scale a stretched viewBox applies to a circle. */}
      <path className="hc-spark-dot" d={`M${x(last.ts).toFixed(1)} ${y(last.value).toFixed(1)}h0.01`} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Ring({ pkey, p, crit, series }) {
  const [lo, hi] = p.range
  const over = p.value > hi
  const frac = Math.max(0.06, Math.min(1, (p.value - lo) / (hi - lo)))
  const dash = over ? 100 : Math.round(frac * 100)
  const status = crit ? 'crit' : p.status
  const rs = crit ? 'crit' : p.status === 'ok' ? 'ok' : 'warn'
  return (
    <div className={`hc-gauge g-${status}`}>
      <svg viewBox="0 0 66 66" className="hc-ring">
        <circle className="hc-ring-track" cx="33" cy="33" r="27" fill="none" strokeWidth="6" />
        <circle className={`hc-ring-prog rs-${rs}`} cx="33" cy="33" r="27" fill="none" strokeWidth="6" strokeLinecap="round"
          pathLength="100" strokeDasharray={`${dash} 100`} transform="rotate(-90 33 33)" />
        <text x="33" y="31" textAnchor="middle" className="hc-ring-val">{fmtVal(pkey, p.value)}</text>
        <text x="33" y="45" textAnchor="middle" className="hc-ring-unit">{p.unit || SHORT[pkey]}</text>
      </svg>
      <div className="hc-gauge-info">
        <div className="hc-gauge-name">{LONG[pkey] ?? p.label}</div>
        {p.status === 'ok'
          ? <div className="hc-gauge-status">{lo}–{hi}</div>
          : <div className={`hc-gauge-status ${status === 'crit' ? 'is-crit' : 'is-warn'}`}>{p.status === 'low' ? Icon.flagDown : Icon.flag} {p.status === 'low' ? 'Low' : 'High'} · {lo}–{hi}</div>}
        <Spark points={series} range={p.range} status={rs} />
      </div>
    </div>
  )
}

// One fetch for every parameter's day, thinned to what a 100px line can show.
export function useTankSeries(hours = 24, every = 5 * 60 * 1000) {
  const [hist] = usePolling(`/api/tank/history?hours=${hours}`, every)
  return useMemo(() => {
    const by = {}
    for (const r of hist?.readings ?? []) (by[r.param] ??= []).push({ ts: r.ts, value: r.value })
    for (const k of Object.keys(by)) {
      const pts = by[k]
      const step = Math.max(1, Math.floor(pts.length / 96))
      by[k] = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
    }
    return by
  }, [hist])
}

// Room air, short: the CO2 number, what it means, temperature and humidity,
// and the day as a line. Tap for the full air view.
function AirCard({ onOpen }) {
  const { env, stale, never, sinceText, status } = useEnvironment(30000)
  const [hist] = usePolling('/api/environment/history?hours=24', 5 * 60 * 1000)
  const series = useMemo(() => {
    const pts = (hist?.readings ?? []).filter((r) => r.co2_ppm != null).map((r) => ({ ts: r.ts, value: r.co2_ppm }))
    const step = Math.max(1, Math.floor(pts.length / 96))
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
  }, [hist])
  const word = { ok: 'Good', warn: 'Getting stuffy', crit: 'Ventilate', stale: 'No reading' }[status]
  // Stale: the last numbers stay on screen, because "it was 755 six days ago"
  // is worth more than a row of dashes - but greyed, unchipped and dated, so
  // nobody reads them as the room right now.
  return (
    <button className={`home-card air-card is-${status}`} onClick={() => onOpen('air')}>
      <div className="hc-head">
        <span className="hc-ico">{Icon.wind}</span>
        <span className="hc-title">Room air</span>
        {(env?.co2_ppm != null || stale) && <span className={`hc-chip chip-${status === 'stale' ? 'stale' : status}`}>{word}</span>}
      </div>
      <div className="air-main">
        <div className="air-big">{env?.co2_ppm != null ? Math.round(env.co2_ppm) : '—'}<small>ppm CO2</small></div>
        <div className="air-meta">
          <span>{env?.temp_c != null ? `${((env.temp_c * 9) / 5 + 32).toFixed(0)}°F` : '—'}</span>
          <span>{env?.humidity_pct != null ? `${Math.round(env.humidity_pct)}% RH` : '—'}</span>
        </div>
      </div>
      {stale
        ? <div className="air-stale">{never ? 'Sensor has never reported — check its wiring' : `Last read ${sinceText} — check the sensor`}</div>
        : <Spark points={series} status={status === 'crit' ? 'crit' : status} width={200} height={22} />}
    </button>
  )
}

export default function HomeCards({ onOpen }) {
  const [tank] = usePolling('/api/tank/latest', 30000)
  const series = useTankSeries()
  const name = tank?.name ?? 'Reef Tank'

  const { params, issues, critical } = tankSummary(tank)
  const keys = GAUGE_ORDER.filter((k) => params[k]?.value != null && params[k]?.range)
  const worst = critical[0] ?? issues[0]
  const worstKey = worst ? Object.keys(params).find((k) => params[k] === worst) : null
  const wrong = critical.length + issues.length

  return (
    <div className="home-grid">
      <button
        className={`home-card tank-card ${critical.length ? 'crit' : issues.length ? 'warn' : 'ok'}`}
        onClick={() => onOpen('tank')}
      >
        <div className="hc-content">
          <div className="hc-head">
            <span className="hc-ico">{Icon.fish}</span>
            <span className="hc-title">{name}</span>
            {worst && (
              <span className={`hc-chip ${critical.length ? 'chip-crit' : 'chip-warn'}`}>
                {worst.status === 'low' ? Icon.flagDown : Icon.flag}{' '}
                {wrong === 1
                  ? `${(SHORT[worstKey] ?? worst.label).toUpperCase()} ${worst.status === 'low' ? 'LOW' : 'HIGH'}`
                  : `${wrong} OUT OF RANGE`}
              </span>
            )}
          </div>
          {keys.length ? (
            <div className="hc-gauges">
              {keys.map((k) => <Ring key={k} pkey={k} p={params[k]} crit={critical.includes(params[k])} series={series[k]} />)}
            </div>
          ) : (
            <div className="hc-muted">Waiting for Apex…</div>
          )}
        </div>
      </button>

      <div className="home-side">
        <WeatherCard onOpen={onOpen} />
        <AirCard onOpen={onOpen} />
        <TankLogCard onOpen={onOpen} />
      </div>
    </div>
  )
}
