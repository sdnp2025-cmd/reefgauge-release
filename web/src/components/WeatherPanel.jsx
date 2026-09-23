import React from 'react'
import { usePolling, weatherLabel } from '../api.js'
import { WeatherGlyph } from './WeatherBits.jsx'

// The look of the weather areas follows the day's outlook.
export function weatherMood(code, tempF) {
  if ([95, 96, 99].includes(code)) return 'storm'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if ([51, 53, 55, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain'
  if ([45, 48].includes(code)) return 'fog'
  if (tempF != null && tempF >= 95) return 'hot'
  if (tempF != null && tempF <= 32) return 'cold'
  if ([0, 1].includes(code)) return 'sunny'
  return 'cloudy'
}

export default function WeatherPanel({ variant, onOpenRadar }) {
  const [data] = usePolling('/api/weather', 10 * 60 * 1000)

  if (variant === 'current') {
    const c = data?.current
    if (!c) return null
    const [label] = weatherLabel(c.code)
    const night = document.documentElement.dataset.mode === 'night'
    let mood = weatherMood(c.code, c.temp)
    if (night && (mood === 'sunny' || mood === 'hot')) {
      mood = 'clearnight'
    }
    return (
      <div className={`weather-now mood-${mood}`}>
        <span className="weather-icon"><WeatherGlyph code={c.code} night={night} size={26} /></span>
        <span className="weather-temp">{Math.round(c.temp)}°</span>
        <span className="weather-meta">
          {label}<br />
          Feels {Math.round(c.feelsLike)}° · {c.humidity}% RH
        </span>
      </div>
    )
  }

  const days = data?.daily ?? []
  const today = days[0]
  const mood = today ? weatherMood(today.code, today.high) : 'cloudy'

  return (
    <div className={`panel forecast-panel mood-${mood}`} onClick={onOpenRadar} role="button" aria-label="Open local radar">
      <h2>⛅ Forecast <span className="tap-hint mood-hint">tap for radar</span></h2>
      {!days.length && <div className="empty-note">Waiting for forecast…</div>}
      <div className="forecast">
        {days.map((d, i) => {
          const weekday = i === 0
            ? 'Today'
            : new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' })
          return (
            <div key={d.date} className="forecast-day">
              <span className="forecast-name">{weekday}</span>
              <span className="forecast-icon"><WeatherGlyph code={d.code} size={22} /></span>
              <span className="forecast-precip">{d.precipChance ? `${d.precipChance}%` : ''}</span>
              <span className="forecast-temps">
                <b>{Math.round(d.high)}°</b> / {Math.round(d.low)}°
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
