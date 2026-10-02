import React from 'react'
import { usePolling } from '../api.js'

export default function RadarOverlay({ onClose }) {
  const [data] = usePolling('/api/weather', 10 * 60 * 1000)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="radar-view" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="month-title">
            {/* Inline SVG, not an emoji: the kiosk image has no colour-emoji font. */}
            <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-0.15em', marginRight: '0.35em' }}>
              <path d="M17.5 17a4.5 4.5 0 0 0-.4-9A7 7 0 0 0 4 10a4 4 0 0 0 1 7.9" /><path d="M8 19v2" /><path d="M12 18v3" /><path d="M16 19v2" />
            </svg>
            Local Radar
          </div>
          <div className="month-nav">
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {data?.radarUrl && (
          <iframe
            className="radar-frame"
            src={data.radarUrl}
            title="Local weather radar"
            loading="lazy"
            // No allow-modals: the embedded page can still run and keep its own
            // storage, but an alert() inside it is dropped instead of becoming a
            // modal over the whole kiosk. Windy's "It seems that radar failed"
            // did exactly that on a customer-state unit - a wall panel blocked
            // behind an OK button from a page the customer never opened.
            sandbox="allow-scripts allow-same-origin"
          />
        )}
      </div>
    </div>
  )
}
