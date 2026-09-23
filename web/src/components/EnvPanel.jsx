import React from 'react'
import { useEnvironment } from '../environment.js'

function cToF(c) {
  return c * 9 / 5 + 32
}

export default function EnvPanel() {
  const { env, stale, never, sinceText } = useEnvironment(30000)
  const co2 = env?.co2_ppm
  // A stale reading is unknown, not good: no green tile, and a line saying so.
  const statusClass = stale
    ? 'status-unknown'
    : { ok: 'status-ok', warn: 'status-low', high: 'status-high' }[env?.co2Status] ?? 'status-unknown'

  return (
    <>
    {stale && (
      <div className="env-stale">
        {never
          ? 'The room-air sensor has never reported. Check its wiring to the terminal.'
          : `No reading from the room-air sensor since ${sinceText}. The numbers below are that last reading.`}
      </div>
    )}
    <div className={`tile-grid env-grid ${stale ? 'is-stale' : ''}`}>
      <div className={`tile ${statusClass}`}>
        <div className="tile-label">CO2</div>
        <div className="tile-value">
          {co2 != null ? Math.round(co2) : '—'}
          <span className="tile-unit">ppm</span>
        </div>
      </div>
      <div className="tile status-unknown">
        <div className="tile-label">Room Temp</div>
        <div className="tile-value">
          {env?.temp_c != null ? cToF(env.temp_c).toFixed(1) : '—'}
          <span className="tile-unit">°F</span>
        </div>
      </div>
      <div className="tile status-unknown">
        <div className="tile-label">Humidity</div>
        <div className="tile-value">
          {env?.humidity_pct != null ? Math.round(env.humidity_pct) : '—'}
          <span className="tile-unit">%</span>
        </div>
      </div>
    </div>
    </>
  )
}
