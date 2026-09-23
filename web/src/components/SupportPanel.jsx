import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// "Get support" — the customer's side of a remote session.
//
// Nobody can reach this terminal from outside. Tapping here dials out to the
// relay and puts a six-digit code on the screen; support can only join by
// being told that code. It ends itself after an hour, and the End button is
// always there. That is the whole security model, and the panel says so in
// those words, because a customer deciding whether to press it deserves to
// know exactly what it does.

function Countdown({ until }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const left = Math.max(0, until - Date.now())
  const m = Math.floor(left / 60000)
  const s = Math.floor((left % 60000) / 1000)
  return <span>{m}:{String(s).padStart(2, '0')}</span>
}

export default function SupportPanel() {
  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = () => api('/api/support/session').then(setSession).catch(() => {})
  useEffect(() => {
    load()
    // While a session is open the code and the "someone is connected" line
    // both come from the server, so poll briskly enough to be honest.
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [])

  const start = async () => {
    setBusy(true); setError(null)
    try {
      await api('/api/support/session', { method: 'POST' })
      // The code arrives from the relay a moment after the socket opens.
      setTimeout(load, 1200)
    } catch (err) {
      setError(String(err.message ?? err))
    } finally { setBusy(false) }
  }

  const end = async () => {
    setBusy(true)
    try { setSession(await api('/api/support/session', { method: 'DELETE' })) } catch (err) { setError(String(err.message ?? err)) } finally { setBusy(false) }
  }

  if (session?.unavailable) {
    return (
      <div className="setup-body">
        <h1>Remote support</h1>
        <div className="setup-note">This terminal has no support relay configured, so a remote session cannot be opened.</div>
      </div>
    )
  }

  if (session?.active && session.code) {
    return (
      <div className="setup-body">
        <h1>Remote support</h1>
        <p>Read this code to support. Nobody can connect without it.</p>
        <div className="support-code">{session.code.slice(0, 3)} {session.code.slice(3)}</div>
        <div className="support-meta">
          {session.operatorPresent
            ? <span className="support-live">● Support is connected now</span>
            : <span>Waiting for support to join</span>}
          {session.expiresAt && <span> · ends in <Countdown until={session.expiresAt} /></span>}
        </div>
        <p className="setup-note">
          While this is open, support can see how the terminal is working — its health, its logs,
          and which of your equipment is answering — and can restart it. They cannot see your
          photos, your coral journal or your test history.
        </p>
        <button className="setup-primary danger" onClick={end} disabled={busy}>End the session now</button>
        {error && <div className="setup-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="setup-body">
      <h1>Remote support</h1>
      <p>
        If you are on the phone with support, this lets them look at the terminal while you talk.
        It opens a connection from here — nobody can reach this terminal otherwise — and gives you
        a six-digit code to read out.
      </p>
      <p className="setup-note">
        The session ends on its own after an hour, and you can end it any time. Support sees how
        the terminal is working, not your tank's photos or history.
      </p>
      <button className="setup-primary" onClick={start} disabled={busy}>
        {busy ? 'Opening…' : 'Get support'}
      </button>
      {session?.error && <div className="setup-error">{session.error}</div>}
      {error && <div className="setup-error">{error}</div>}
    </div>
  )
}
