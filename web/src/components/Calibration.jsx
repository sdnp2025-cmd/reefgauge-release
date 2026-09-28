import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import Keypad from './Keypad.jsx'

// Calibrating the air sensors.
//
// Until now this existed only as an API call, which meant it was not a feature:
// a customer whose screen says 88 F in a 72 F room had no way to fix it, and
// neither did anyone helping them over the phone without SSH.
//
// Two separate corrections live here, and they are not the same kind of thing.
//
// Temperature is a known offset. Both sensors read high because they sit in
// warm enclosures - a board in a sealed case behind a backlight, a puck in a
// cabinet with a pump in it - and the chip has an offset register for exactly
// this. Give it one honest thermometer reading and the arithmetic is settled.
// The offset also fixes humidity, which is derived from the same temperature,
// so an uncorrected sensor reports the room drier than it is too.
//
// CO2 is a reference. There is no arithmetic to do: the sensor has to be put in
// air whose concentration is known and told what it is. Outdoor air is the one
// concentration anyone can rely on without equipment.

const asF = (c) => (c == null ? null : (c * 9) / 5 + 32)
const show = (v, d = 0) => (v == null ? '—' : v.toFixed(d))

const NAME = { display: 'Screen sensor', cabinet: 'Cabinet puck' }
const WHERE = {
  display: 'behind the panel, measuring the room',
  cabinet: 'in the cabinet, measuring what the skimmer draws'
}

function Reading({ sensor }) {
  return (
    <div className={`cal-sensor ${sensor.belowFreshAir ? 'suspect' : ''}`}>
      <div className="cal-sensor-head">
        <b>{NAME[sensor.location]}</b>
        <em>{WHERE[sensor.location]}</em>
      </div>
      <div className="cal-sensor-nums">
        <div><span>{show(asF(sensor.tempC))}</span><em>°F</em></div>
        <div><span>{show(sensor.co2Ppm)}</span><em>ppm CO₂</em></div>
      </div>
      <div className="cal-sensor-foot">
        Correcting by {show(sensor.offsetC, 1)} °C
        {sensor.offsetC === sensor.defaultOffsetC ? ' (never calibrated)' : ''}
      </div>
    </div>
  )
}

export default function Calibration() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState(null)
  const [keypad, setKeypad] = useState(false)
  // Which sensors one thermometer reading speaks for. Two sensors in the same
  // room are in one air and one reading is right for both; a puck already in
  // the cabinet is in warmer air and has to be given its own.
  const [scope, setScope] = useState('all')

  const load = () => api('/api/environment/calibration')
    .then((d) => {
      setData(d)
      if (d.sensors.length < 2) setScope(d.sensors[0]?.location ?? 'display')
    })
    .catch((e) => setError(String(e.message ?? e)))

  useEffect(() => { load() }, [])

  const post = async (path, body) => {
    setBusy(true); setError(null); setSaid(null)
    try {
      const res = await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      await load()
      return res
    } catch (e) {
      setError(String(e.message ?? e))
      return null
    } finally { setBusy(false) }
  }

  const calibrate = async (referenceF) => {
    setKeypad(false)
    const res = await post('/api/environment/calibrate', { referenceF, location: scope })
    if (!res) return
    // Say what moved, per sensor. "Saved" is not useful feedback for something
    // whose whole purpose is that a number on the wall changes.
    const settled = show(referenceF)
    setSaid(res.sensors.map((s) => (
      `${NAME[s.location]} was reading ${show(asF(s.measuredC))} °F`
    )).join(' · ')
      // The sensors re-read the offset on their own cycle, so the number on the
      // wall does not change on this tap. Saying so stops it looking broken.
      + `. Both will settle to about ${settled} °F within a minute.`.replace('Both', res.sensors.length > 1 ? 'Both' : 'It')
      + (res.skipped.length ? ` (${res.skipped.map((k) => `${NAME[k.location]} skipped — ${k.reason}`).join('; ')})` : ''))
  }

  const recalibrate = async (location, ppm, label) => {
    const res = await post('/api/environment/frc', { location, ppm })
    if (res) setSaid(`${NAME[location]} will recalibrate to ${label} on its next reading.`)
  }

  if (error && !data) return <div className="setup-error">{error}</div>
  if (!data) return <div className="setup-note">Loading…</div>

  const display = data.sensors.find((s) => s.location === 'display')
  const cabinet = data.sensors.find((s) => s.location === 'cabinet')
  const spreadF = data.tempSpreadC == null ? null : (data.tempSpreadC * 9) / 5

  return (
    <div className="setup-body calibration">
      <h1>Calibration</h1>

      {!data.sensors.length && (
        <p className="setup-note">No air sensor has reported yet. There is nothing to calibrate until one does.</p>
      )}

      <div className="cal-sensors">
        {data.sensors.map((s) => <Reading key={s.location} sensor={s} />)}
      </div>

      {/* Two sensors in one room are measuring one temperature, so any gap
          between them is error by definition - and worth saying out loud,
          because it is the thing a customer notices and cannot explain. */}
      {spreadF != null && spreadF >= 2 && (
        <p className="cal-flag">
          These two disagree by {show(spreadF)} °F. If they are sitting in the same room they are
          measuring the same air, so at least one of them is wrong.
        </p>
      )}

      <h2>Temperature</h2>
      <p className="setup-note">
        Both sensors sit in warm enclosures and read above the room. Tell the terminal what a
        thermometer or thermostat in the room actually says and it works out the correction —
        which fixes the humidity reading too.
      </p>

      {display && cabinet && (
        <div className="cal-scope">
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            <b>Both sensors</b><em>they are in the same room, in the same air</em>
          </button>
          <button className={scope === 'display' ? 'on' : ''} onClick={() => setScope('display')}>
            <b>Screen only</b><em>the puck is somewhere warmer, like the cabinet</em>
          </button>
          <button className={scope === 'cabinet' ? 'on' : ''} onClick={() => setScope('cabinet')}>
            <b>Puck only</b><em>using a thermometer beside the puck</em>
          </button>
        </div>
      )}

      {!!data.sensors.length && (
        <button className="setup-primary" disabled={busy} onClick={() => setKeypad(true)}>
          Enter the room temperature
        </button>
      )}

      <h2>CO₂</h2>
      <p className="setup-note">
        A CO₂ sensor cannot be corrected by arithmetic — it has to be shown air it can trust.
        Outdoor air is about {data.freshAirPpm} ppm everywhere on Earth, so that is the reference.
      </p>

      {data.sensors.filter((s) => s.belowFreshAir).map((s) => (
        <p className="cal-flag" key={s.location}>
          {NAME[s.location]} reads {s.co2Ppm} ppm. Outdoor air is about {data.freshAirPpm} ppm and
          indoor air is always higher, so this sensor is reading low and needs recalibrating.
        </p>
      ))}

      {data.sensors.map((s) => (
        <div className="cal-frc" key={s.location}>
          <div className="cal-frc-head"><b>{NAME[s.location]}</b>
            {s.lastFrc && (
              <em>{s.lastFrc.ok
                ? `Last recalibrated to ${s.lastFrc.referencePpm} ppm`
                : `Last attempt failed: ${s.lastFrc.error ?? 'no reason given'}`}</em>
            )}
          </div>

          {s.pendingFrc ? (
            <div className="setup-note">
              Waiting for it to recalibrate to {s.pendingFrc.ppm} ppm. Leave it in the fresh air
              until this clears — it happens on its next reading.
            </div>
          ) : (
            <div className="cal-frc-actions">
              <button className="setup-primary compact" disabled={busy}
                onClick={() => recalibrate(s.location, data.freshAirPpm, `outdoor air (${data.freshAirPpm} ppm)`)}>
                Outdoor air
              </button>
              {/* Referencing one sensor against the other is only honest while
                  they share air, and only in this direction: the screen's
                  sensor self-calibrates against the fresh air a house sees, and
                  the puck deliberately does not, because a sealed cabinet never
                  sees any. So the screen is the known-good one of the pair. */}
              {s.location === 'cabinet' && display?.co2Ppm != null && (
                <button className="setup-primary compact" disabled={busy}
                  onClick={() => recalibrate('cabinet', display.co2Ppm, `the screen sensor (${display.co2Ppm} ppm)`)}>
                  Match the screen ({display.co2Ppm} ppm)
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      <p className="setup-note">
        For outdoor air: put the sensor outside, or by a wide-open window away from anyone
        breathing near it, and give it five minutes to settle before tapping. Getting this wrong
        writes a wrong reference into the sensor, so it is worth the five minutes.
      </p>

      {said && <p className="cal-said">{said}</p>}
      {error && <div className="setup-error">{error}</div>}

      {keypad && (
        <Keypad
          title="Room temperature"
          subtitle={scope === 'all' ? 'what a thermometer in this room says' : `beside the ${scope === 'cabinet' ? 'puck' : 'screen'}`}
          unit="°F"
          initial={72}
          onCommit={calibrate}
          onClose={() => setKeypad(false)}
        />
      )}
    </div>
  )
}
