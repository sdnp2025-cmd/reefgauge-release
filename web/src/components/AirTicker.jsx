import React from 'react'
import { useEnvironment } from '../environment.js'
import { api, usePolling } from '../api.js'

// Persistent scrolling status banner across the bottom of the screen —
// room air stays glanceable from any view without spending a whole home
// card on it. Tap to open the full Air & Maintenance view.
// Icons are inline SVG (the kiosk has no color-emoji font).

const I = {
  wind: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.6 4.6A2 2 0 1 1 11 8H2" /><path d="M12.6 19.4A2 2 0 1 0 14 16H2" /><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" /></svg>,
  therm: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z" /></svg>,
  drop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.7s6.5 7.3 6.5 12a6.5 6.5 0 0 1-13 0c0-4.7 6.5-12 6.5-12z" /></svg>,
  wrench: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14.5 12l-2.5-2.5z" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5l7 12H5z" /><path d="M12 10v3" /></svg>
}

export default function AirTicker({ onOpen }) {
  const { env, stale: envStale } = useEnvironment(30000)
  const [maint] = usePolling('/api/maint', 5 * 60 * 1000)
  const [redsea] = usePolling('/api/redsea/status', 60000)
  // Checked often: this is how a family finds out the tank stopped reporting.
  const [alerts] = usePolling('/api/alerts', 20000)

  const dueTasks = (maint?.tasks ?? []).filter((t) => t.dueInDays <= 0)
  const gearAlerts = redsea?.alerts ?? []
  const co2Class = envStale ? 'stale' : env?.co2Status === 'high' ? 'bad' : env?.co2Status === 'warn' ? 'warn' : 'ok'

  // Red Sea equipment already scrolls past under its own logic; showing it
  // twice would just make the ticker longer.
  // Unacknowledged alerts are the alert card's business, not the ticker's:
  // the card is loud and in the way until it is tapped, and only then does
  // the alert retreat to here. Notices nobody is asked to acknowledge (the
  // 'default' priority) show straight away.
  const active = (alerts?.active ?? []).filter((a) => !a.key.startsWith('redsea:'))
    .filter((a) => a.acknowledged || !(a.priority === 'urgent' || a.priority === 'high'))
  const critical = active.filter((a) => a.priority === 'urgent' || a.priority === 'high')
  // Alarms that are off should say so somewhere a person will find it. A
  // silence with no visible undo is how a tank ends up unmonitored for a month
  // because somebody pressed a button once.
  const quieted = critical.filter((a) => a.silenced)
  const allQuiet = critical.length > 0 && quieted.length === critical.length
  const bypassed = alerts?.bypassUntil != null

  // The panel sounds an alarm for anything critical. Whoever walks up to it
  // needs a way to stop the noise without dismissing the problem, and without
  // hunting through a settings screen while it beeps at them.
  const post = async (event, path) => {
    event.stopPropagation()      // acting on the alarm is not navigating
    try {
      await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
    } catch { /* the next poll settles it either way */ }
  }

  const content = (
    <>
      {/* Anything actually wrong leads, ahead of the routine readings — a
          silent tank is the one thing the ticker exists to shout about. */}
      {active.map((a) => (
        <React.Fragment key={a.key}>
          <span className={`tick-seg tick-${a.priority === 'urgent' || a.priority === 'high' ? 'bad' : 'warn'}`}>
            {I.alert} {a.title}
          </span>
          <span className="tick-sep">•</span>
        </React.Fragment>
      ))}
      <span className="tick-seg">{I.wind} ROOM AIR</span>
      <span className="tick-sep">•</span>
      <span className={`tick-seg ${envStale ? 'tick-stale' : ''}`}>
        <span className={`tick-dot dot-${co2Class}`} /> {envStale ? 'CO2 — no reading' : `CO2 ${Math.round(env.co2_ppm)} ppm`}
      </span>
      <span className="tick-sep">•</span>
      <span className="tick-seg">{I.therm} {env?.temp_c != null ? `${((env.temp_c * 9) / 5 + 32).toFixed(0)}°F` : '—'}</span>
      <span className="tick-sep">•</span>
      <span className="tick-seg">{I.drop} Humidity {env?.humidity_pct != null ? `${Math.round(env.humidity_pct)}%` : '—'}</span>
      <span className="tick-sep">•</span>
      <span className="tick-seg">{I.wrench} {dueTasks.length ? `${dueTasks.map((t) => t.name).join(' · ')} due` : 'Maintenance up to date'}</span>
      {gearAlerts.map((a, i) => (
        <React.Fragment key={i}>
          <span className="tick-sep">•</span>
          <span className={`tick-seg tick-${a.level}`}>{I.alert} {a.device}: {a.text}</span>
        </React.Fragment>
      ))}
    </>
  )

  // Tapping goes where the news is: the tank when it has stopped reporting,
  // equipment while a Red Sea alert scrolls past, room air otherwise.
  const target = critical.some((a) => a.key.startsWith('apex:') || a.key.startsWith('tank:'))
    ? 'tank'
    : gearAlerts.length ? 'equipment' : 'air'

  return (
    <button
      className={`air-ticker status-${
        critical.length || gearAlerts.some((a) => a.level === 'bad')
          ? 'bad'
          : active.length || gearAlerts.length ? 'warn' : co2Class
      }`}
      onClick={() => onOpen(target)}
      aria-label={active.length ? `${active.length} alert${active.length === 1 ? '' : 's'}` : gearAlerts.length ? 'Equipment alerts' : 'Room air details'}
    >
      <div className="air-ticker-track">
        <span className="air-ticker-content">{content}</span>
        <span className="air-ticker-content">{content}</span>
      </div>
      {/* One slot, two states: quiet it, or admit it is quiet and offer it back. */}
      {critical.length > 0 && (
        (allQuiet || bypassed) ? (
          <span
            className="ticker-silence resumed"
            role="button"
            tabIndex={0}
            onClick={(e) => post(e, '/api/alerts/resume')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') post(e, '/api/alerts/resume') }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6 9H3v6h3l5 4z" /><path d="M16 9.5a4 4 0 0 1 0 5" /><path d="M19 7a8 8 0 0 1 0 10" />
            </svg>
            Alarms off · Resume
          </span>
        ) : (
          <span
            className="ticker-silence"
            role="button"
            tabIndex={0}
            onClick={(e) => post(e, '/api/alerts/silence')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') post(e, '/api/alerts/silence') }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6 9H3v6h3l5 4z" /><path d="M17 9l4 6M21 9l-4 6" />
            </svg>
            Silence
          </span>
        )
      )}
    </button>
  )
}
