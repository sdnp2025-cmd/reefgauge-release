import React from 'react'
import { usePolling } from '../api.js'

export default function RadarOverlay({ onClose }) {
  const [data] = usePolling('/api/weather', 10 * 60 * 1000)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="radar-view" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="month-title">🌧️ Local Radar</div>
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
          />
        )}
      </div>
    </div>
  )
}
