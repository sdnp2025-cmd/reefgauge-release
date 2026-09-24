import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Getting the tank's alarms onto a phone.
//
// The wall panel sounds whether or not anyone is in the room, which is exactly
// the problem: the 3am one nobody hears is the one that costs a tank. This is
// the other half of the alarm, and until now it could only be switched on by
// editing config.json over SSH.
//
// The whole flow is one scan. ntfy needs no account on either end, so there is
// nothing to sign up for, nothing to type, and everyone in the house scans the
// same code. What that costs is that the topic is a bearer secret - anyone who
// has it can read the alarms and, worse, invent one - so it is 24 random bytes
// the terminal generates and never asks anyone to remember.

export default function PhoneAlerts() {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState(null)
  const [error, setError] = useState(null)
  const [confirmRegen, setConfirmRegen] = useState(false)

  const load = () => api('/api/alerts/phone').then(setState).catch((e) => setError(String(e.message ?? e)))
  useEffect(() => { load() }, [])

  const enable = async (regenerate = false) => {
    setBusy(true); setError(null); setTested(null); setConfirmRegen(false)
    try {
      setState(await api('/api/alerts/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate })
      }))
    } catch (e) { setError(String(e.message ?? e)) } finally { setBusy(false) }
  }

  const turnOff = async () => {
    setBusy(true); setError(null); setTested(null)
    try { setState(await api('/api/alerts/phone', { method: 'DELETE' })) }
    catch (e) { setError(String(e.message ?? e)) } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true); setError(null); setTested(null)
    try {
      await api('/api/alerts/test', { method: 'POST' })
      setTested('sent')
    } catch (e) { setTested(null); setError(String(e.message ?? e)) } finally { setBusy(false) }
  }

  if (!state) return <div className="setup-note">Loading…</div>

  if (!state.enabled) {
    return (
      <div className="phone-alerts">
        <h2>Phone alerts</h2>
        <p className="setup-note">
          The panel sounds an alarm whether or not anyone is in the room. This also sends it
          to your phone — so you hear about the tank at 3am, or from work.
        </p>
        <button className="setup-primary" onClick={() => enable(false)} disabled={busy}>
          {busy ? 'Setting up…' : 'Send alarms to my phone'}
        </button>
        {error && <div className="setup-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="phone-alerts">
      <h2>Phone alerts</h2>
      <div className="phone-alerts-body">
        <div
          className="phone-alerts-qr"
          // The server draws the QR; it holds the topic and should not have to
          // hand it to the browser just to have it drawn again.
          dangerouslySetInnerHTML={{ __html: state.svg ?? '' }}
        />
        <div className="phone-alerts-steps">
          <ol>
            <li>Point your phone's camera at this code.</li>
            <li>It opens the <b>ntfy</b> app — install it first if you do not have it, then scan again.</li>
            <li>Tap <b>Subscribe</b>.</li>
          </ol>
          <p className="setup-note">
            Everyone in the house can scan the same code. Keep it to people you would trust with
            the tank — anyone who has it receives every alarm.
          </p>
          <div className="phone-alerts-actions">
            <button className="setup-primary" onClick={test} disabled={busy}>
              {busy ? 'Sending…' : 'Send a test'}
            </button>
            {tested && <span className="setup-ok">Sent. It should arrive in a second or two.</span>}
          </div>
        </div>
      </div>

      {confirmRegen ? (
        <div className="phone-alerts-danger">
          <b>Start a new code?</b>
          <p className="setup-note">
            Every phone subscribed now stops getting alarms and has to scan again. Do this if
            someone has the old code who should not.
          </p>
          <button className="setup-primary danger" onClick={() => enable(true)} disabled={busy}>
            Yes, start a new code
          </button>
          <button className="setup-primary ghost" onClick={() => setConfirmRegen(false)}>Cancel</button>
        </div>
      ) : (
        <div className="phone-alerts-foot">
          <button className="hub-linkish" onClick={() => setConfirmRegen(true)}>Start a new code</button>
          <button className="hub-linkish" onClick={turnOff} disabled={busy}>Turn phone alerts off</button>
        </div>
      )}

      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
