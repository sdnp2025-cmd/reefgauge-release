import React from 'react'
import { useEnvironment } from '../environment.js'

function cToF(c) {
  return c * 9 / 5 + 32
}

export default function EnvPanel() {
  const { env, stale, never, sinceText,
          cabinet, cabinetStale, cabinetSinceText, cabinetTrapped, cabinetGap } = useEnvironment(30000)
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

    {/* The cabinet, when a puck has ever reported. A terminal without one shows
        nothing here rather than an empty slot for something not bought.

        This is the half the product exists for. The skimmer draws its air from
        the cabinet, so it is cabinet CO2 - not room CO2 - that sets a ceiling
        on the tank's pH, and the number that matters is the gap between them.
        The home card carries the headline; somebody who taps through wants the
        detail, and until now it was the one place the puck disappeared. */}
    {cabinet && (
      <>
        <div className="env-section">
          <span>Cabinet</span>
          {!cabinetStale && cabinetGap != null && (
            <em>{cabinetGap > 0 ? `${cabinetGap} ppm above the room` : 'level with the room'}</em>
          )}
        </div>

        {cabinetStale && (
          <div className="env-stale">
            No reading from the cabinet puck since {cabinetSinceText}. The numbers
            below are that last reading — check the puck has power and is on the network.
          </div>
        )}

        <div className={`tile-grid env-grid ${cabinetStale ? 'is-stale' : ''}`}>
          <div className={`tile ${cabinetStale ? 'status-unknown' : cabinetTrapped ? 'status-high' : 'status-ok'}`}>
            <div className="tile-label">CO2</div>
            <div className="tile-value">
              {cabinet.co2_ppm != null ? Math.round(cabinet.co2_ppm) : '—'}
              <span className="tile-unit">ppm</span>
            </div>
          </div>
          <div className="tile status-unknown">
            <div className="tile-label">Cabinet Temp</div>
            <div className="tile-value">
              {cabinet.temp_c != null ? cToF(cabinet.temp_c).toFixed(1) : '—'}
              <span className="tile-unit">°F</span>
            </div>
          </div>
          <div className="tile status-unknown">
            <div className="tile-label">Humidity</div>
            <div className="tile-value">
              {cabinet.humidity_pct != null ? Math.round(cabinet.humidity_pct) : '—'}
              <span className="tile-unit">%</span>
            </div>
          </div>
        </div>

        {/* Said in words, because the number alone does not explain itself.
            Only when it is actually high - a cabinet level with the room is
            working correctly and needs no commentary. */}
        {!cabinetStale && cabinetTrapped && (
          <div className="env-note">
            The cabinet is holding {cabinetGap} ppm more CO2 than the room. The skimmer
            draws this air, so it can push the tank's pH down. More ventilation under
            the stand, or running the skimmer's air line to outside the cabinet, fixes it.
          </div>
        )}
      </>
    )}
    </>
  )
}
