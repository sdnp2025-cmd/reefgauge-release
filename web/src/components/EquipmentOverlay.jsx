import React, { useState } from 'react'
import { usePolling } from '../api.js'

// Full-screen detail for Red Sea equipment, opened by tapping an alert.
// Red Sea's own control app is phone-only and the devices serve no web UI of
// their own, so this shows everything the hardware reports plus what to do
// about it — the kiosk can't hand off to ReefBeat.

// Guidance per (device type, alert). Keyed loosely so a new alert string still
// renders, just without the extra "what to do".
function guidance(device, alert) {
  const t = alert.text.toLowerCase()
  if (device.type === 'reef-mat') {
    if (t.includes('roll empty')) {
      return [
        'Open the ReefMat lid and lift out the empty core.',
        'Fit the new roll, feeding the leading edge over the drum onto the take-up spool.',
        'Register the new roll in the ReefBeat app so the length counter resets.'
      ]
    }
    if (t.includes('nearly out')) return ['Order or set aside a replacement roll — it will run out within days.']
    if (t.includes('sensor')) return ['Wipe the optical sensor window in the ReefMat housing; salt creep makes it misread.']
  }
  if (device.type === 'reef-run') {
    if (t.includes('cup')) {
      return [
        'Lift out the skimmer collection cup and empty it.',
        'Rinse the cup and the neck, then seat it back down.',
        'The pump restarts on its own once the float sensor clears.'
      ]
    }
    if (t.includes('not connected')) return ['Check the pump\'s cable at the ReefRun controller and at the pump itself.']
    if (t.includes('running warm') || t.includes('running hot')) {
      return [
        'Pull the pump and clear the intake screen and impeller of algae and snail shells.',
        'Check the sump water level — a pump drawing air runs hotter.',
        'If it stays warm with a clean intake, the bearing is wearing: plan a replacement pump.'
      ]
    }
    if (t.includes('sensor missing')) return ['Reseat the sensor cable on the ReefRun controller.']
  }
  if (t.includes('not responding')) {
    return [
      'Confirm the unit has power and its status light is on.',
      'Check it is still joined to your Wi-Fi in the ReefBeat app.',
      'If its IP address changed, re-scan from Settings → Equipment.'
    ]
  }
  return []
}

const HIDE = new Set(['success', 'message', 'is_internet_connected', 'linked', 'synced'])

function label(key) {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function fmt(v) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v).replace(/_/g, ' ')
}

// Flatten the device dashboard into label/value rows, one level into objects
// (ReefRun nests each pump).
function rows(raw) {
  const out = []
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (HIDE.has(k) || v == null) continue
    if (Array.isArray(v)) continue
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (HIDE.has(k2) || v2 == null || typeof v2 === 'object') continue
        out.push([`${v.name ?? label(k)} · ${label(k2)}`, fmt(v2)])
      }
    } else {
      out.push([label(k), fmt(v)])
    }
  }
  return out
}

export default function EquipmentOverlay({ onClose }) {
  const [rs] = usePolling('/api/redsea/status', 30000)
  const devices = rs?.devices ?? []
  const [openId, setOpenId] = useState(null)
  const selected = devices.find((d) => d.id === openId) ?? devices[0]

  return (
    <div className="overlay" onClick={onClose}>
      <div className="equip-view" onClick={(e) => e.stopPropagation()}>
        <div className="equip-bar">
          <span className="view-title">Reef Equipment</span>
          <button className="view-btn" onClick={onClose}>Close</button>
        </div>

        {devices.length > 1 && (
          <div className="equip-tabs">
            {devices.map((d) => (
              <button
                key={d.id}
                className={`equip-tab ${d.id === selected?.id ? 'active' : ''} ${d.alerts?.length ? 'has-alert' : ''}`}
                onClick={() => setOpenId(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}

        {!selected && <div className="empty-note">No Red Sea equipment found on the network.</div>}

        {selected && (
          <div className="equip-body">
            <div className="equip-head">
              <div>
                <div className="equip-name">{selected.name}</div>
                <div className="equip-sub">{selected.model ?? selected.type} · {selected.ip}</div>
              </div>
              <div className="equip-headline">{selected.headline}</div>
            </div>

            {(selected.alerts ?? []).map((a, i) => (
              <div key={i} className={`equip-alert is-${a.level}`}>
                <div className="equip-alert-top">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5l7 12H5z" /><path d="M12 10v3" /></svg>
                  <span>{a.text}</span>
                </div>
                {guidance(selected, a).length > 0 && (
                  <ol className="equip-steps">
                    {guidance(selected, a).map((s, j) => <li key={j}>{s}</li>)}
                  </ol>
                )}
              </div>
            ))}

            <div className="equip-readings">
              {rows(selected.raw).map(([k, v]) => (
                <div key={k} className="equip-reading">
                  <em>{k}</em>
                  <b>{v}</b>
                </div>
              ))}
            </div>

            <div className="equip-note">
              ReefGauge reads this equipment directly over your network. Changing its settings
              still needs the ReefBeat app on your phone — Red Sea provides no on-device controls.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
