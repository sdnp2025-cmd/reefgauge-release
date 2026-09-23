import React from 'react'
import { usePolling } from '../api.js'

// Red Sea ReefBeat equipment strip, shown under the gauges in the Tank view.
// Devices are auto-discovered on the LAN; anything Red Sea we haven't mapped
// specifically still renders with its own dashboard fields.

const ICONS = {
  'reef-mat': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4.5" /><path d="M3 20c0-3 4-5 9-5s9 2 9 5" /><path d="M12 3.5v9" /></svg>
  ),
  'reef-run': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v4" /><path d="M12 18v4" /><path d="M2 12h4" /><path d="M18 12h4" /><path d="M4.9 4.9 7.8 7.8" /><path d="M16.2 16.2l2.9 2.9" /></svg>
  ),
  'reef-led': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.6 1 2.3h6c0-.7.4-1.9 1-2.3A7 7 0 0 0 12 2z" /></svg>
  ),
  'reef-dose': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.7s6.5 7.3 6.5 12a6.5 6.5 0 0 1-13 0c0-4.7 6.5-12 6.5-12z" /></svg>
  ),
  'reef-ato': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15c2.4 0 2.4 2 4.8 2s2.4-2 4.8-2 2.4 2 4.8 2" /><path d="M4 19c2.4 0 2.4 2 4.8 2s2.4-2 4.8-2 2.4 2 4.8 2" /><path d="M12 2v9" /><path d="m8.5 7.5 3.5 3.5 3.5-3.5" /></svg>
  ),
  'reef-wave': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8c2.5 0 2.5 2.5 5 2.5S9.5 8 12 8s2.5 2.5 5 2.5S19.5 8 22 8" /><path d="M2 15c2.5 0 2.5 2.5 5 2.5s2.5-2.5 5-2.5 2.5 2.5 5 2.5 2.5-2.5 5-2.5" /></svg>
  )
}

const FALLBACK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10" /><path d="M7 14h6" /></svg>
)

export default function RedSeaPanel({ onOpen }) {
  const [rs] = usePolling('/api/redsea/status', 30000)
  const devices = rs?.devices ?? []
  if (!devices.length) return null

  return (
    <div className="rs-strip">
      {devices.map((d) => {
        const worst = (d.alerts ?? []).some((a) => a.level === 'bad')
          ? 'bad'
          : (d.alerts ?? []).length ? 'warn' : 'ok'
        return (
          <button key={d.id} className={`rs-card rs-${worst}`} onClick={onOpen}>
            <div className="rs-head">
              <span className="rs-ico">{ICONS[d.type] ?? FALLBACK_ICON}</span>
              <span className="rs-name">{d.name}</span>
              <span className="rs-headline">{d.headline}</span>
            </div>
            <div className="rs-metrics">
              {(d.metrics ?? []).map((m) => (
                <span key={m.label} className="rs-metric">
                  <em>{m.label}</em>
                  <b>{m.value}</b>
                </span>
              ))}
            </div>
            {(d.alerts ?? []).map((a, i) => (
              <div key={i} className={`rs-alert is-${a.level}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5l7 12H5z" /><path d="M12 10v3" /></svg>
                <span>{a.text}</span>
              </div>
            ))}
          </button>
        )
      })}
    </div>
  )
}
