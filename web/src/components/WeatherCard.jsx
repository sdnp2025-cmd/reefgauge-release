import React from 'react'
import { usePolling, weatherLabel } from '../api.js'
import { weatherMood } from './WeatherPanel.jsx'
import { WeatherGlyph } from './WeatherBits.jsx'
import WeatherScene from './WeatherScene.jsx'

// The weather card on the home screen. It had the numbers and a mood-tinted
// wash, but nothing in it moved and nothing said what the numbers meant: "H 83
// · L 64" is two facts about a day you have to assemble yourself, when the
// question being asked from across the kitchen is "is it warming up or not".
//
// So: a sky that behaves like the weather it is reporting, and a range bar
// that puts the current temperature between today's low and high where it can
// be read at a glance.

const Icon = {
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9" />
    </svg>
  ),
  drop: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" />
    </svg>
  )
}

// Where today's temperature sits between its low and its high. The bar is
// coloured cool-to-warm along its length, so the dot's position carries the
// reading twice — by where it is and by what colour it is sitting on.
function RangeBar({ low, high, now }) {
  if (low == null || high == null || now == null) return null
  const span = high - low
  const pct = span > 0 ? Math.max(0, Math.min(1, (now - low) / span)) : 0.5
  return (
    <div className="wx-range">
      <span className="wx-range-end">{Math.round(low)}°</span>
      <span className="wx-range-track">
        <span className="wx-range-dot" style={{ left: `${pct * 100}%` }} />
      </span>
      <span className="wx-range-end">{Math.round(high)}°</span>
    </div>
  )
}

export default function WeatherCard({ onOpen }) {
  const [weather] = usePolling('/api/weather', 10 * 60 * 1000)

  const cur = weather?.current
  const today = weather?.daily?.[0]
  const night = document.documentElement.dataset.mode === 'night'
  let mood = cur ? weatherMood(cur.code, cur.temp) : 'cloudy'
  if (night && (mood === 'sunny' || mood === 'hot')) mood = 'clearnight'

  const hours = (weather?.hourly ?? []).slice(1, 5)
  // Sun or moon per forecast slot: compare each hour's time-of-day to today's
  // sun times, so a 5am slot in June is not drawn with a moon over it.
  const tod = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() }
  const sr = weather?.sun?.sunrise ? tod(weather.sun.sunrise) : 7 * 60
  const ss = weather?.sun?.sunset ? tod(weather.sun.sunset) : 19 * 60
  const slotNight = (t) => { const m = tod(t); return m < sr || m >= ss }

  const rain = today?.precipChance ?? 0

  return (
    <button className={`home-card weather-card wx-${mood}`} onClick={() => onOpen('weather')}>
      <WeatherScene mood={mood} />
      <div className="wx-tint" aria-hidden="true" />
      <div className="hc-content">
        <div className="hc-head">
          <span className="hc-ico">{Icon.cloud}</span>
          <span className="hc-title">Weather</span>
          {/* Only when there is something to say. A "0%" chip every dry day
              trains the eye to skip the one place rain would be announced. */}
          {rain > 0 && (
            <span className="wx-rain-chip">{Icon.drop} {rain}%</span>
          )}
        </div>

        <div className="wx-main">
          <div className="wx-temp">{cur ? `${Math.round(cur.temp)}°` : '—'}</div>
          <div className="wx-meta">
            <div className="wx-cond">{cur ? weatherLabel(cur.code)[0] : ''}</div>
            <div className="wx-feels">{cur ? `Feels ${Math.round(cur.feelsLike)}°` : ''}</div>
          </div>
        </div>

        <RangeBar low={today?.low} high={today?.high} now={cur?.temp} />

        {hours.length > 0 && (
          <div className="wx-strip">
            {hours.map((h) => (
              <span key={h.time} className="wx-slot">
                <em>{new Date(h.time).toLocaleTimeString([], { hour: 'numeric' })}</em>
                <WeatherGlyph code={h.code} night={slotNight(h.time)} size={18} />
                <b>{Math.round(h.temp)}°</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}
