import React, { useEffect, useState } from 'react'
import { api, waitForServer } from '../api.js'
import OnScreenKeyboard from './OnScreenKeyboard.jsx'
import UpdatePanel from './UpdatePanel.jsx'
import WifiByPhone from './WifiByPhone.jsx'

// Inline icons — the Pi image has no color-emoji font, so emoji render as
// empty boxes on the customer's very first screen.
const S = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const Ico = {
  lock: <svg {...S} className="ico"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>,
  flask: <svg {...S} className="ico"><path d="M9 3h6" /><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3" /></svg>,
  wifi: <svg {...S} className="ico"><path d="M2 8.5a16 16 0 0 1 20 0" /><path d="M5 12a11 11 0 0 1 14 0" /><path d="M8.5 15.5a6 6 0 0 1 7 0" /><path d="M12 19.5h.01" /></svg>,
  pin: <svg {...S} className="ico"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>,
  gear: <svg {...S} className="ico"><circle cx="12" cy="12" r="4" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="M4.9 4.9 7 7" /><path d="M17 17l2.1 2.1" /><path d="M19.1 4.9 17 7" /><path d="M7 17l-2.1 2.1" /></svg>
}

const STEPS = ['Welcome', 'Wi-Fi', 'Location', 'Tank name', 'Apex', 'Equipment', 'Finish']

function signalBars(signal) {
  return signal >= 75 ? '▂▄▆█' : signal >= 50 ? '▂▄▆' : signal >= 25 ? '▂▄' : '▂'
}

// `section` opens one step on its own — the Settings screen hands us a step
// number instead of starting the whole six-step run. In that mode the wizard
// has no notion of "next": finishing a section means saving it and going back
// to the list you came from.
export default function SetupWizard({ reconfigure, onExit, section }) {
  const single = Number.isInteger(section)
  const [step, setStep] = useState(single ? section : 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [answers, setAnswers] = useState({})

  // Wi-Fi step state
  const [networks, setNetworks] = useState(null)
  const [pickedSsid, setPickedSsid] = useState(null)
  const [wifiPassword, setWifiPassword] = useState('')
  const [wifiOk, setWifiOk] = useState(null)

  // Location step state
  const [locQuery, setLocQuery] = useState('')
  const [locResults, setLocResults] = useState(null)

  // Apex step state
  const [apexFound, setApexFound] = useState(null)
  const [apexHost, setApexHost] = useState('')
  const [apexUser, setApexUser] = useState('admin')
  const [apexPass, setApexPass] = useState('1234')
  const [apexVerified, setApexVerified] = useState(null)
  // What the terminal is connected to right now, so re-opening this step from
  // Settings does not greet a working controller with "Find your Apex".
  const [apexCurrent, setApexCurrent] = useState(null)
  const [apexChanging, setApexChanging] = useState(false)

  // Red Sea equipment step state
  const [gear, setGear] = useState(null)      // discovered/known Red Sea devices
  const [gearOff, setGearOff] = useState([])  // hwids the customer excluded
  const [gearNames, setGearNames] = useState({})
  const [gearIp, setGearIp] = useState('')
  const [tankName, setTankName] = useState('')

  // Which text field the on-screen keyboard is editing
  const [kbTarget, setKbTarget] = useState(null)
  const kbSetters = { wifiPassword: setWifiPassword, locQuery: setLocQuery, apexHost: setApexHost, apexUser: setApexUser, apexPass: setApexPass, gearIp: setGearIp, tankName: setTankName }
  // `gearName:<hwid>` targets one device's nickname, so the keyboard can edit a
  // field that doesn't have its own useState.
  const kbSetter = (target) => {
    if (target?.startsWith('gearName:')) {
      const hwid = target.slice('gearName:'.length)
      return (update) => setGearNames((m) => ({ ...m, [hwid]: update(m[hwid] ?? '') }))
    }
    return kbSetters[target] ?? (() => {})
  }
  const [finishing, setFinishing] = useState(false)
  // In single-section mode every "Continue" is really "save this and go back".
  // The save is deferred by one render because the step handlers call
  // setAnswers(...) and then next() together, and reading `answers` here would
  // read the value from before their own edit.
  const [savePending, setSavePending] = useState(false)
  const next = () => {
    setError(null)
    setKbTarget(null)
    if (single) {
      // Wi-Fi is applied by NetworkManager the moment it connects; there is
      // nothing in `answers` for it and nothing to write.
      if (section === 1) { onExit?.(); return }
      setSavePending(true)
      return
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }
  const back = () => {
    setError(null)
    setKbTarget(null)
    if (single) { onExit?.(); return }
    setStep((s) => Math.max(s - 1, 0))
  }

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(String(err.message ?? err))
      return null
    } finally {
      setBusy(false)
    }
  }

  const scanWifi = () => run(async () => {
    setNetworks((await api('/api/setup/wifi/networks')).networks)
  })

  const connectWifi = () => run(async () => {
    const res = await fetch('/api/setup/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: pickedSsid, password: wifiPassword })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Could not connect')
    setWifiOk(pickedSsid)
    setKbTarget(null)
  })

  const searchLocation = () => run(async () => {
    setLocResults((await api(`/api/setup/location?q=${encodeURIComponent(locQuery)}`)).results)
  })

  const scanApex = () => run(async () => {
    setApexFound(null)
    const { found } = await api('/api/setup/apex/scan', { method: 'POST' })
    setApexFound(found)
    if (found.length === 1) setApexHost(found[0].host)
  })

  const verifyApex = () => run(async () => {
    const res = await fetch('/api/setup/apex/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: apexHost, username: apexUser, password: apexPass })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Verification failed')
    setApexVerified(data)
    setAnswers((a) => ({ ...a, apex: { host: apexHost, username: apexUser, password: apexPass, inputs: data.mapping } }))
    setKbTarget(null)
  })

  // Apex step. A controller is usually already set — this step is reached far
  // more often from Settings than from a first run — so start from what the
  // terminal is actually talking to, and only scan if the customer asks.
  const loadApex = async () => {
    try {
      const [summary, health] = await Promise.all([api('/api/setup/summary'), api('/api/health')])
      const host = summary?.apex
      if (!host) { setApexCurrent({ host: null }); return }
      let params = {}
      try { params = (await api('/api/tank/latest'))?.params ?? {} } catch { /* not fatal */ }
      setApexCurrent({
        host,
        ok: health?.apex === 'ok',
        error: health?.apex !== 'ok' ? health?.apex : null,
        ageSec: health?.lastTankUpdate ? Math.round((Date.now() - health.lastTankUpdate) / 1000) : null,
        values: Object.fromEntries(
          Object.entries(params).filter(([, v]) => v?.value != null).map(([k, v]) => [v.label ?? k, `${v.value}${v.unit ? ' ' + v.unit : ''}`])
        )
      })
      if (!apexHost) setApexHost(host)
    } catch {
      setApexCurrent({ host: null })
    }
  }

  // Equipment step. Devices already known to the server show instantly; a scan
  // sweeps the LAN for anything added since.
  const loadGear = () => run(async () => {
    const { devices, hidden } = await api('/api/redsea/status')
    const row = (d) => ({ ip: d.ip, hwid: d.id, type: d.type, model: d.model, name: d.name, headline: d.headline })
    // Units the customer hid earlier come back unticked, so they can be
    // brought back from here rather than by editing a file.
    setGear([...(devices ?? []), ...(hidden ?? [])].map(row))
    setGearOff((hidden ?? []).map((d) => d.id))
  })

  const scanGear = () => run(async () => {
    const { found } = await api('/api/setup/redsea/scan', { method: 'POST' })
    setGear((prev) => {
      const byHwid = new Map((prev ?? []).map((d) => [d.hwid, d]))
      for (const d of found) byHwid.set(d.hwid, d)
      return [...byHwid.values()]
    })
  })

  const addGearByIp = () => run(async () => {
    const res = await fetch('/api/setup/redsea/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: gearIp.trim() })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Could not reach that address')
    // Typed in by hand, so remember the address: discovery will not find a
    // unit on another subnet. Discovered units are never remembered by address.
    setGear((prev) => [...(prev ?? []).filter((d) => d.hwid !== data.device.hwid), { ...data.device, manual: true }])
    setGearIp('')
    setKbTarget(null)
  })

  // Fold the current selection into `answers` so Finish persists it. What is
  // saved is who, not where: the units to hide, their names, and only the
  // addresses the customer typed in. Anything discovered stays discovered,
  // so equipment can change over the years without another visit here.
  const saveGear = () => {
    const kept = (gear ?? []).filter((d) => !gearOff.includes(d.hwid))
    setAnswers((a) => ({
      ...a,
      redSea: {
        enabled: true,
        exclude: (gear ?? []).filter((d) => gearOff.includes(d.hwid)).map((d) => d.hwid),
        hosts: kept.filter((d) => d.manual).map((d) => d.ip),
        names: Object.fromEntries(
          kept.map((d) => [d.hwid, gearNames[d.hwid] ?? d.name]).filter(([, n]) => n)
        )
      }
    }))
    next()
  }

  const finish = () => run(async () => {
    setFinishing(true)
    await api('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answers)
    })
    await waitForServer()
    window.location.replace('/')
  })

  useEffect(() => {
    if (step === 3 && !tankName) api('/api/tank/latest').then((d) => { if (d?.name && d.name !== 'Reef Tank') setTankName(d.name) }).catch(() => {})
    if (step === 4 && apexCurrent == null) loadApex()
    if (step === 1 && networks == null) scanWifi()
    if (step === 5 && gear == null) loadGear()
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!savePending) return
    setSavePending(false)
    setFinishing(true)
    api('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answers)
    })
      // Saving restarts the server. Wait for it to answer again before
      // reloading — a page that loads into the gap gets a failed fetch for
      // every card and draws "not set up" over settings that are set.
      .then(() => waitForServer())
      .then(() => window.location.replace('/?settings=1'))
      .catch((err) => { setFinishing(false); setError(String(err.message ?? err)) })
  }, [savePending]) // eslint-disable-line react-hooks/exhaustive-deps

  const fieldProps = (name, value) => ({
    value,
    readOnly: true,
    onFocus: () => setKbTarget(name),
    onClick: () => setKbTarget(name),
    className: kbTarget === name ? 'setup-input focused' : 'setup-input'
  })

  if (single && finishing) {
    return (
      <div className="setup">
        <div className="setup-card">
          <div className="setup-body">
            <h1>Saving…</h1>
            <p>Applying your change and restarting the dashboard.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="setup">
      <div className="setup-card">
        {!single && <div className="setup-progress">
          {STEPS.map((label, i) => (
            <div key={label} className={`setup-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
              <span>{i < step ? '✓' : i + 1}</span>
              <em>{label}</em>
            </div>
          ))}
        </div>}

        {step === 0 && (
          <div className="setup-body">
            <img className="setup-logo" src="/brand/reefgauge-logo-600.png" alt="" draggable="false" />
            <h1>Welcome to ReefGauge</h1>
            <p>Let's get your display set up. This takes about five minutes: connect to Wi-Fi, find your Apex, and find your Red Sea gear.</p>
            <button className="setup-primary" onClick={next}>Get Started</button>
            {reconfigure && <button className="setup-skip" onClick={onExit}>Exit setup</button>}
            {reconfigure && <UpdatePanel />}
          </div>
        )}

        {step === 1 && (
          <div className="setup-body">
            <h1>Connect to Wi-Fi</h1>
            {wifiOk ? (
              <>
                <p className="setup-ok">✓ Connected to {wifiOk}</p>
                <button className="setup-primary" onClick={next}>{single ? 'Save' : 'Continue'}</button>
              </>
            ) : pickedSsid ? (
              <>
                <p>Password for <b>{pickedSsid}</b>:</p>
                <input {...fieldProps('wifiPassword', wifiPassword)} placeholder="Tap to enter password" type="text" />
                <button className="setup-primary" onClick={connectWifi} disabled={busy}>
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
                <button className="setup-skip" onClick={() => { setPickedSsid(null); setKbTarget(null) }}>‹ Different network</button>
              </>
            ) : (
              <>
                <p>Choose your home network:</p>
                <div className="setup-list">
                  {networks == null && <div className="setup-note">Scanning…</div>}
                  {networks?.map((n) => (
                    <button key={n.ssid} className="setup-row" onClick={() => setPickedSsid(n.ssid)}>
                      <span>{n.ssid}</span>
                      <span className="setup-row-meta">{n.security ? Ico.lock : null} {signalBars(n.signal)}</span>
                    </button>
                  ))}
                </div>
                <button className="setup-skip" onClick={scanWifi} disabled={busy}>↻ Rescan</button>
                <WifiByPhone onDone={(ssid) => { setWifiOk(ssid); setPickedSsid(null) }} />
                <button className="setup-skip" onClick={single ? onExit : next}>{single ? 'Done' : 'Skip (using ethernet) ›'}</button>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="setup-body">
            <h1>Where is the tank?</h1>
            <p>Used for your local weather, radar, and sunrise/sunset theme.</p>
            <div className="setup-inline">
              <input {...fieldProps('locQuery', locQuery)} placeholder="City or town…" />
              <button className="setup-primary compact" onClick={searchLocation} disabled={busy || locQuery.length < 2}>Search</button>
            </div>
            <div className="setup-list">
              {locResults?.length === 0 && <div className="setup-note">No matches — try a bigger nearby city.</div>}
              {locResults?.map((r) => (
                <button
                  key={r.label}
                  className={`setup-row ${answers.location?.label === r.label ? 'selected' : ''}`}
                  onClick={() => { setAnswers((a) => ({ ...a, location: r })); setKbTarget(null) }}
                >
                  <span>{r.label}</span>
                  {answers.location?.label === r.label && <span>✓</span>}
                </button>
              ))}
            </div>
            <button className="setup-primary" onClick={next} disabled={!answers.location}>{single ? 'Save' : 'Continue'}</button>
            <button className="setup-skip" onClick={single ? onExit : next}>{single ? 'Close without changing' : 'Skip ›'}</button>
          </div>
        )}

        {step === 3 && (
          <div className="setup-body">
            <h1>Name your tank</h1>
            <p>It goes at the top of every screen. "The 120", "Living room reef", whatever you call it.</p>
            <input {...fieldProps('tankName', tankName)} placeholder="Tank name…" maxLength={40} />
            <button className="setup-primary" onClick={() => { setAnswers((a) => ({ ...a, tankName })); setKbTarget(null); next() }} disabled={!tankName.trim()}>{single ? 'Save' : 'Continue'}</button>
            <button className="setup-skip" onClick={single ? onExit : next}>{single ? 'Close without changing' : 'Skip ›'}</button>
          </div>
        )}

        {step === 4 && (
          <div className="setup-body">
            <h1>{apexCurrent?.host && !apexChanging && !apexVerified ? 'Your Apex' : 'Find your Apex'}</h1>
            {apexCurrent == null && !apexVerified && <div className="setup-note">Checking your controller…</div>}
            {apexCurrent?.host && !apexChanging && !apexVerified ? (
              <>
                {apexCurrent.ok ? (
                  <p className="setup-ok">✓ Connected to {apexCurrent.host}{apexCurrent.ageSec != null && apexCurrent.ageSec < 600 ? ` — last reading ${apexCurrent.ageSec < 90 ? `${apexCurrent.ageSec} seconds` : `${Math.round(apexCurrent.ageSec / 60)} minutes`} ago` : ''}</p>
                ) : (
                  <div className="setup-error">{apexCurrent.host} is not answering: {apexCurrent.error}</div>
                )}
                {Object.keys(apexCurrent.values ?? {}).length > 0 && (
                  <div className="setup-params">
                    {Object.entries(apexCurrent.values).map(([k, v]) => (
                      <div key={k} className="setup-param"><b>{v}</b><span>{k}</span></div>
                    ))}
                  </div>
                )}
                <button className="setup-primary" onClick={single ? onExit : next}>{single ? 'Done' : 'Continue'}</button>
                <button className="setup-skip" onClick={() => { setApexChanging(true); setApexFound(null) }}>Use a different controller ›</button>
              </>
            ) : apexVerified ? (
              <>
                <p className="setup-ok">✓ Connected — live readings:</p>
                <div className="setup-params">
                  {Object.entries(apexVerified.values).map(([k, v]) => (
                    <div key={k} className="setup-param"><b>{v}</b><span>{k}</span></div>
                  ))}
                </div>
                <button className="setup-primary" onClick={next}>{single ? 'Looks right — Save' : 'Looks right — Continue'}</button>
                <button className="setup-skip" onClick={() => setApexVerified(null)}>‹ Try again</button>
              </>
            ) : (
              <>
                <p>The terminal will scan your network for a Neptune Apex controller.</p>
                {apexFound == null
                  ? <button className="setup-primary" onClick={scanApex} disabled={busy}>{busy ? 'Scanning network…' : 'Scan for Apex'}</button>
                  : apexFound.length === 0 && <div className="setup-note">No Apex found — enter its address below, or make sure it's powered on and on the same network.</div>}
                {apexFound?.map((f) => (
                  <button key={f.host} className={`setup-row ${apexHost === f.host ? 'selected' : ''}`} onClick={() => setApexHost(f.host)}>
                    <span>{Ico.flask} {f.label}</span>
                    {apexHost === f.host && <span>✓</span>}
                  </button>
                ))}
                {apexFound != null && (
                  <>
                    <div className="setup-inline">
                      <input {...fieldProps('apexHost', apexHost)} placeholder="Apex address (IP)" />
                    </div>
                    <div className="setup-inline">
                      <input {...fieldProps('apexUser', apexUser)} placeholder="Username" />
                      <input {...fieldProps('apexPass', apexPass)} placeholder="Password" />
                    </div>
                    <button className="setup-primary" onClick={verifyApex} disabled={busy || !apexHost}>
                      {busy ? 'Checking…' : 'Connect to Apex'}
                    </button>
                  </>
                )}
                <button className="setup-skip" onClick={() => (apexCurrent?.host ? setApexChanging(false) : single ? onExit() : next())}>
                  {apexCurrent?.host ? '‹ Keep the current controller' : single ? 'Close without changing' : 'Skip for now ›'}
                </button>
              </>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="setup-body">
            <h1>Your Red Sea equipment</h1>
            <p>
              The terminal reads your ReefBeat gear directly over your network — no ReefBeat
              account needed. Add or remove equipment here any time it changes.
            </p>

            {gear == null && <div className="setup-note">Looking for equipment…</div>}
            {gear?.length === 0 && (
              <div className="setup-note">
                Nothing found yet. Make sure each unit is powered on and joined to your Wi-Fi in
                the ReefBeat app, then scan again — or add it by IP address below.
              </div>
            )}

            {gear?.length > 0 && (
              <div className="setup-list">
                {gear.map((d) => {
                  const off = gearOff.includes(d.hwid)
                  return (
                    <div key={d.hwid} className={`gear-row ${off ? 'is-off' : ''}`}>
                      <button
                        className="gear-check"
                        onClick={() => setGearOff((list) => off ? list.filter((h) => h !== d.hwid) : [...list, d.hwid])}
                        aria-label={off ? `Include ${d.name}` : `Exclude ${d.name}`}
                      >
                        {off ? '' : '✓'}
                      </button>
                      <input
                        {...fieldProps(`gearName:${d.hwid}`, gearNames[d.hwid] ?? d.name)}
                        className={`${fieldProps(`gearName:${d.hwid}`, '').className} gear-name`}
                      />
                      <span className="gear-meta">{d.model ?? d.type} · {d.ip}{d.headline ? ` · ${d.headline}` : ''}</span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="setup-inline">
              <input {...fieldProps('gearIp', gearIp)} placeholder="Add by IP address" />
              <button className="setup-primary compact" onClick={addGearByIp} disabled={busy || !gearIp.trim()}>Add</button>
            </div>

            <button className="setup-primary" onClick={scanGear} disabled={busy}>
              {busy ? 'Scanning your network…' : gear?.length ? 'Scan again for new equipment' : 'Scan for equipment'}
            </button>
            {gear?.length > 0 && (
              <button className="setup-primary" onClick={saveGear} disabled={busy}>{single ? 'Save' : 'Continue'}</button>
            )}
            <button className="setup-skip" onClick={single ? onExit : next}>{single ? 'Close without changing' : 'Skip for now ›'}</button>
          </div>
        )}

        {step === 6 && !single && (
          <div className="setup-body">
            {finishing ? (
              <>
                <img className="setup-logo" src="/brand/reefgauge-logo-600.png" alt="" draggable="false" />
                <h1>Finishing up…</h1>
                <p>Saving your settings and starting the dashboard.</p>
              </>
            ) : (
              <>
                <h1>All set!</h1>
                <div className="setup-summary">
                  <div>{Ico.wifi} Wi-Fi: <b>{wifiOk ?? 'skipped'}</b></div>
                  <div>{Ico.pin} Location: <b>{answers.location?.label ?? 'skipped'}</b></div>
                  <div>{Ico.flask} Tank: <b>{answers.tankName ?? 'unnamed'}</b></div>
                  <div>{Ico.flask} Apex: <b>{answers.apex?.host ?? 'skipped'}</b></div>
                  <div>{Ico.gear} Equipment: <b>{answers.redSea ? `${Object.keys(answers.redSea.names).length} unit${Object.keys(answers.redSea.names).length === 1 ? '' : 's'}, auto-detecting new ones` : 'auto-detect'}</b></div>
                </div>
                <p className="setup-note">
                  Once the dashboard is up, tap the picture button in the top corner to put a
                  code on screen — scan it to send family photos from any phone.
                </p>
                <button className="setup-primary" onClick={finish} disabled={busy}>Start ReefGauge</button>
                {step > 0 && <button className="setup-skip" onClick={back}>‹ Back</button>}
              </>
            )}
          </div>
        )}

        {error && <div className="setup-error">{error}</div>}
        {single && !finishing && (
          <button className="setup-back" onClick={onExit}>‹ Settings</button>
        )}
        {!single && step > 0 && step < STEPS.length - 1 && !finishing && (
          <button className="setup-back" onClick={back}>‹ Back</button>
        )}
      </div>

      {kbTarget && (
        <OnScreenKeyboard
          onKey={(c) => kbSetter(kbTarget)((v) => v + c)}
          onBackspace={() => kbSetter(kbTarget)((v) => v.slice(0, -1))}
          onSubmit={() => setKbTarget(null)}
          onClose={() => setKbTarget(null)}
          submitLabel="Done"
        />
      )}
    </div>
  )
}
