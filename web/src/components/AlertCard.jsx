import React, { useEffect, useMemo, useState } from 'react'
import { api, usePolling } from '../api.js'
import { Spark, fmtVal, LONG } from './HomeCards.jsx'

// A new alert is loud and in the way until a person deals with it; then it
// retreats to the ticker. This is the loud part.
//
// Anything worth acknowledging - a parameter out of its range, room CO2, the
// tank gone silent - is a pop-up box in the middle of the screen over the
// dimmed dashboard, and it stays there until it is tapped. Tapping it zooms
// it away; the next one, if there is one, pops in behind it. Notices nobody
// is asked to acknowledge (maintenance, equipment) go straight to the ticker.
//
// The box carries the reading itself, big, with its last day as a line and
// the target band behind it, so the tap is an informed one. Worst first.

const PRIORITY = { urgent: 0, high: 1, default: 2, low: 3 }
const LEAVE_MS = 380

// ?alertdemo=1 shows a sample box without anything being wrong - for looking
// at the design, and for filming it. Tapping it behaves like the real thing.
const DEMO = new URLSearchParams(location.search).has('alertdemo')
const DEMO_SINCE = Date.now() - 14 * 60000
const DEMO_ALERTS = [
  { key: 'tank:salinity', title: 'Salinity HIGH', priority: 'high', since: DEMO_SINCE, dir: 'HIGH', acknowledged: false },
  { key: 'apex:offline', title: 'Apex OFFLINE', message: 'No data from the Apex for over 10 minutes — check the controller and network.', priority: 'urgent', since: DEMO_SINCE + 1, acknowledged: false }
]

// Reads as a phrase on its own, so it can never produce "for just now".
function since(ts) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just went out of range'
  if (m < 60) return `out of range for ${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `out of range for ${h} h ${m % 60} min` : `out of range for ${Math.floor(h / 24)} d`
}

export default function AlertCard() {
  const [alerts] = usePolling('/api/alerts', 10000)
  const [tank] = usePolling('/api/tank/latest', 30000)
  const [busy, setBusy] = useState(null)
  // Occurrences tapped on this screen (key -> the alert's `since`), so the box
  // leaves the moment it is tapped rather than on the next poll. Keyed by
  // occurrence, not by key alone: the same parameter going wrong again has a
  // new `since` and must shout again. Entries fall away once the server
  // reports the acknowledgement itself.
  const [done, setDone] = useState(() => new Map())
  const [leaving, setLeaving] = useState(null)
  useEffect(() => {
    if (!alerts || done.size === 0) return
    const stale = [...done].filter(([key, at]) => {
      const live = alerts.active?.find((a) => a.key === key)
      return !live || live.acknowledged || live.since !== at
    })
    if (stale.length) setDone((d) => { const n = new Map(d); stale.forEach(([k]) => n.delete(k)); return n })
  }, [alerts])

  const pending = useMemo(() => (DEMO ? DEMO_ALERTS : (alerts?.active ?? []))
    // Silenced or bypassed alarms were dealt with on purpose - someone with
    // their hands in the tank does not want a box for every reading they knock.
    .filter((a) => !a.acknowledged && !a.silenced && done.get(a.key) !== a.since && !a.key.startsWith('redsea:')
      && (a.priority === 'urgent' || a.priority === 'high'))
    .sort((a, b) => (DEMO ? 0 : (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9)) || a.since - b.since), [alerts, done])
  // While one is zooming away it stays mounted; the next waits its turn.
  const alert = leaving ?? pending[0] ?? null

  // The parameter behind a tank alert, for the reading and the line.
  const pkey = alert?.key.startsWith('tank:') ? alert.key.slice(5) : null
  const p = pkey ? tank?.params?.[pkey] : null
  const [hist, setHist] = useState(null)
  useEffect(() => {
    setHist(null)                      // never draw the last alert's day against this one's range
    if (!pkey) return
    let live = true
    api(`/api/tank/history?param=${pkey}&hours=24`)
      .then((d) => { if (live) setHist(d.readings.map((r) => ({ ts: r.ts, value: r.value }))) })
      .catch(() => {})
    return () => { live = false }
  }, [pkey, alert?.since])

  // Nothing about the terminal's idle behaviour may hide an unacknowledged
  // alert: the screensaver checks this flag before it dims anything.
  useEffect(() => {
    document.body.classList.toggle('has-alert', !!alert)
    return () => document.body.classList.remove('has-alert')
  }, [!!alert])

  if (!alert) return null

  const ack = async () => {
    if (busy || leaving) return
    setBusy(alert.key)
    try {
      if (!DEMO) await api('/api/alerts/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: alert.key })
      })
    } catch { /* the next poll settles it */ }
    setBusy(null)
    // Zoom away, then let the next one in.
    setLeaving(alert)
    setDone((d) => new Map(d).set(alert.key, alert.since))
    setTimeout(() => setLeaving(null), LEAVE_MS)
  }

  const urgent = alert.priority === 'urgent'
  const status = p ? (p.status === 'ok' ? 'ok' : 'crit') : 'crit'
  const heading = pkey
    ? `${LONG[pkey] ?? p?.label ?? pkey} ${alert.dir === 'LOW' ? 'low' : 'high'}`
    : alert.title
  return (
    <div className={`alert-dim ${leaving ? 'is-leaving' : ''}`}>
      <div key={alert.key} className={`alert-card ${urgent ? 'is-urgent' : ''} ${leaving ? 'is-leaving' : ''}`} role="alertdialog" aria-live="assertive">
        <div className="alert-top">
          <div className="alert-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><path d="M12 17.5v.5" /></svg>
          </div>
          <div className="alert-head">{heading}</div>
        </div>
        {p ? (
          <>
            <div className="alert-reading">
              <span className="alert-value">{fmtVal(pkey, p.value)}<small>{p.unit}</small></span>
              <div className="alert-facts">
                <span>target {p.range[0]}–{p.range[1]}{p.unit ? ` ${p.unit}` : ''}</span>
                <span>{since(alert.since)}</span>
                {hist?.length > 1 && <span>was {fmtVal(pkey, hist[0].value)} a day ago</span>}
              </div>
            </div>
            <Spark points={hist} range={p.range} status={status} width={320} height={44} />
          </>
        ) : (
          <div className="alert-text">{alert.message}</div>
        )}
        <button className="alert-ack" onClick={ack} disabled={busy === alert.key || !!leaving}>
          {urgent ? "I'm on it" : 'Got it'}
          {pending.length > 1 && <small>{pending.length - 1} more</small>}
        </button>
      </div>
    </div>
  )
}
