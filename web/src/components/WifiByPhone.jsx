import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Setting up Wi-Fi without typing on the wall.
//
// A Wi-Fi password is a long string of mixed case and symbols, usually printed
// in small type on the underside of a router, and the on-screen keyboard makes
// entering it the worst thing this product asks anyone to do. So the terminal
// raises its own network instead and hands the job to the phone already in
// their hand, where the password autofills from the phone's own keychain.
//
// Two codes, in order, because they do different jobs and a phone can only act
// on one at a time:
//
//   The first is a WIFI: payload - the format iOS and Android cameras already understand,
//   so scanning it offers "join this network" with no app to install.
//   The second is a plain URL, which opens the setup page over that network.
//
// The terminal has one radio, so raising this network takes it off the one it
// was on. The panel says so before anything happens rather than after.

export default function WifiByPhone({ onDone, onCancel }) {
    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [left, setLeft] = useState(null)

    // Poll while it is up: the phone finishing on its own is the normal ending,
    // and the panel should notice rather than waiting to be told.
    useEffect(() => {
        if (!state?.active) return
        const id = setInterval(async () => {
            try {
                const s = await api('/api/setup/wifi/status')
                if (s.ssid) { onDone?.(s.ssid); return }
            } catch { /* the hotspot has no route to anywhere; that is expected */ }
            if (state.expiresAt) setLeft(Math.max(0, state.expiresAt - Date.now()))
        }, 4000)
        return () => clearInterval(id)
    }, [state, onDone])

    const start = async () => {
        setBusy(true); setError(null)
        try { setState(await api('/api/setup/wifi/hotspot', { method: 'POST' })) }
        catch (e) { setError(String(e.message ?? e)) } finally { setBusy(false) }
    }

    const stop = async () => {
        setBusy(true)
        try { await api('/api/setup/wifi/hotspot', { method: 'DELETE' }) } catch { /* going back anyway */ }
        setState(null); setBusy(false); onCancel?.()
    }

    if (!state?.active) {
        return (
            <div className="wifi-phone-intro">
                <button className="setup-primary" onClick={start} disabled={busy}>
                    {busy ? 'Starting…' : 'Set up from my phone instead'}
                </button>
                <p className="setup-note">
                    No typing on this screen. The terminal makes its own network for a few minutes,
                    your phone joins it by scanning a code, and you pick your home network there.
                </p>
                {error && <div className="setup-error">{error}</div>}
            </div>
        )
    }

    const mins = left == null ? null : Math.ceil(left / 60000)

    return (
        <div className="wifi-phone">
            <div className="wifi-phone-codes">
                <div className="wifi-phone-step">
                    <div className="wifi-phone-num">1</div>
                    <div className="wifi-phone-qr" dangerouslySetInnerHTML={{ __html: state.wifiSvg ?? '' }} />
                    <b>Scan to join the terminal</b>
                    <span>Your phone will offer to join <b>{state.ssid}</b>. Tap join.</span>
                </div>
                <div className="wifi-phone-step">
                    <div className="wifi-phone-num">2</div>
                    <div className="wifi-phone-qr" dangerouslySetInnerHTML={{ __html: state.setupSvg ?? '' }} />
                    <b>Then scan this one</b>
                    <span>It opens the setup page on your phone. Pick your home network there.</span>
                </div>
            </div>
            <p className="setup-note">
                This screen will say when you are connected.
                {mins != null && mins > 0 && ` The terminal's network switches itself off in ${mins} min.`}
            </p>
            <button className="setup-skip" onClick={stop} disabled={busy}>‹ Use this screen instead</button>
            {error && <div className="setup-error">{error}</div>}
        </div>
    )
}
