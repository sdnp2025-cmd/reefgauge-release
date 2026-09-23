import React from 'react'
import WeatherScene from './WeatherScene.jsx'

// Design scratch pad: every sky at once, at the size it will be on the wall.
// Reachable only at ?weather=1. Nine conditions are impossible to judge one
// forecast at a time — the snow card would otherwise be drawn blind in
// September and reviewed in January.

const MOODS = [
  ['sunny', 'Sunny', 84, 'Clear', 62, 88, 0],
  ['hot', 'Hot', 97, 'Hot', 74, 99, 0],
  ['cloudy', 'Cloudy', 68, 'Cloudy', 58, 72, 20],
  ['rain', 'Rain', 57, 'Rain', 52, 61, 90],
  ['storm', 'Storm', 71, 'Thunderstorm', 64, 79, 80],
  ['snow', 'Snow', 28, 'Snow', 21, 33, 70],
  ['cold', 'Cold', 36, 'Clear', 28, 41, 10],
  ['fog', 'Fog', 51, 'Fog', 47, 58, 30],
  ['clearnight', 'Clear night', 64, 'Clear', 58, 82, 0]
]

const DropIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" />
  </svg>
)

export default function WeatherGallery() {
  return (
    <div className="wx-gallery">
      {MOODS.map(([mood, name, temp, cond, low, high, rain]) => {
        const pct = Math.max(0, Math.min(1, (temp - low) / (high - low)))
        return (
          <div key={mood} className={`home-card weather-card wx-${mood}`}>
            <WeatherScene mood={mood} />
            <div className="wx-tint" aria-hidden="true" />
            <div className="hc-content">
              <div className="hc-head">
                <span className="hc-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9" />
                  </svg>
                </span>
                <span className="hc-title">{name}</span>
                {rain > 0 && <span className="wx-rain-chip">{DropIcon} {rain}%</span>}
              </div>
              <div className="wx-main">
                <div className="wx-temp">{temp}°</div>
                <div className="wx-meta">
                  <div className="wx-cond">{cond}</div>
                  <div className="wx-feels">Feels {temp - 2}°</div>
                </div>
              </div>
              <div className="wx-range">
                <span className="wx-range-end">{low}°</span>
                <span className="wx-range-track">
                  <span className="wx-range-dot" style={{ left: `${pct * 100}%` }} />
                </span>
                <span className="wx-range-end">{high}°</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
