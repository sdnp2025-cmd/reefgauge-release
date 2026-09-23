import React from 'react'
import { usePolling } from '../api.js'

// The card that carries the tank's written history: what has been put in
// the water, and what the lab found in it. They sit in the right-hand column
// of the home screen, under the weather and the room air.

const S = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const Icon = {
  drop: <svg {...S}><path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" /></svg>,
  flask: <svg {...S}><path d="M9 3h6" /><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3" /></svg>
}

const DAY = 24 * 3600 * 1000

// "6 days ago" is what a person wants from a maintenance date. An actual date
// makes them do the subtraction themselves, standing at the tank.
//
// Counted in calendar days rather than elapsed hours. Something dosed at two
// yesterday afternoon is "yesterday" all through today - measuring elapsed
// time called it "today" until two o'clock came round again, which is not
// what anyone standing at the tank means by the word.
export function agoLabel(ts) {
  if (!ts) return null
  const then = new Date(ts); then.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((today - then) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}

const ELEMENT_ORDER = (a, b) => a.element.localeCompare(b.element)

export function TankLogCard({ onOpen }) {
  const [log] = usePolling('/api/log/summary', 60000)
  const [icp] = usePolling('/api/log/icp?limit=1', 5 * 60 * 1000)
  const water = log?.lastWaterChange
  const doses = log?.dosedToday ?? []
  const test = icp?.tests?.[0] ?? null
  const results = (test?.results ?? []).slice().sort(ELEMENT_ORDER)
  const off = results.filter((r) => r.status !== 'ok').length

  // A water change is due weekly in most tanks, so the count of days since is
  // the number that decides whether tonight is the night.
  const overdue = water ? (Date.now() - water.ts) / DAY >= 7 : false

  return (
    <button className={`home-card log-card ${overdue ? 'attention' : ''}`} onClick={() => onOpen('log')}>
      <div className="hc-head">
        <span className="hc-ico">{Icon.drop}</span>
        <span className="hc-title">Chemistry</span>
      </div>

      {water ? (
        <div className="log-lead">
          <span className={`log-lead-value ${overdue ? 'is-warn' : ''}`}>{agoLabel(water.ts)}</span>
          <span className="log-lead-label">
            water change{water.gallons ? ` · ${water.gallons} gal` : ''}
          </span>
        </div>
      ) : (
        <div className="log-lead">
          <span className="log-lead-value muted">No water change logged</span>
          <span className="log-lead-label">tap to record one</span>
        </div>
      )}

      {doses.length > 0 ? (
        <ul className="log-doses">
          {doses.slice(0, 3).map((d) => (
            <li key={d.supplement}>
              <span className="log-dose-name">{d.supplement}</span>
              <span className="log-dose-ml">{d.ml ? `${d.ml} ml` : `${d.n}×`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hc-muted">Nothing dosed today</div>
      )}

      {/* The lab's last word: every element as a tile, so the pattern reads
          before any symbol does. Tap the row for the full ICP screen. */}
      <div className={`log-icp ${off ? 'is-warn' : ''}`} onClick={(e) => { e.stopPropagation(); onOpen('icp') }} role="button">
        <div className="log-icp-head">
          {Icon.flask}
          <span>ICP</span>
          {test ? <span className="log-icp-when">{agoLabel(test.ts)}</span> : <span className="log-icp-when">no test yet</span>}
          {test && <span className="log-icp-sum">{off === 0 ? `all ${results.length} in range` : <><b>{off}</b> of {results.length} outside range</>}</span>}
        </div>
        {test && (
          <div className="icp-heat icp-heat-mini">
            {results.map((r) => <span key={r.element} className={`icp-tile is-${r.status} sev-${r.severity ?? 'unknown'}`}>{r.element}</span>)}
          </div>
        )}
      </div>
    </button>
  )
}
