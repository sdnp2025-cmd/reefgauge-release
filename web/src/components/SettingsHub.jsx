import React, { useEffect, useRef, useState } from 'react'
import { api, waitForServer } from '../api.js'
import { useDragScroll } from '../dragScroll.js'
import SetupWizard from './SetupWizard.jsx'
import PhotoManager from './PhotoManager.jsx'
import UpdatePanel from './UpdatePanel.jsx'
import AlarmSettings from './AlarmSettings.jsx'
import ScreensaverSettings from './ScreensaverSettings.jsx'
import SupportPanel from './SupportPanel.jsx'
import DosingSettings from './DosingSettings.jsx'
import OnScreenKeyboard from './OnScreenKeyboard.jsx'

// The settings screen. It used to be the first-run wizard, restarted from the
// top: to change the alarm tone you re-confirmed your Wi-Fi, re-picked your
// town and walked past your Apex. Six steps to change one thing is not a
// settings screen, it is a punishment for having settings.
//
// So this is a list of things, each saying what it is set to now, each opening
// only itself. The wizard still owns the steps it already knows how to draw —
// this hands it a section number instead of starting it at zero.

const S = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const Ico = {
  wifi: <svg {...S}><path d="M2 8.5a16 16 0 0 1 20 0" /><path d="M5 12a11 11 0 0 1 14 0" /><path d="M8.5 15.5a6 6 0 0 1 7 0" /><path d="M12 19.5h.01" /></svg>,
  pin: <svg {...S}><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>,
  tag: <svg {...S}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M7.5 7.5h.01" /></svg>,
  flask: <svg {...S}><path d="M9 3h6" /><path d="M10 3v6.5L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-9.5V3" /></svg>,
  gear: <svg {...S}><circle cx="12" cy="12" r="4" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="M2 12h3" /><path d="M19 12h3" /><path d="M4.9 4.9 7 7" /><path d="M17 17l2.1 2.1" /><path d="M19.1 4.9 17 7" /><path d="M7 17l-2.1 2.1" /></svg>,
  bell: <svg {...S}><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>,
  speaker: <svg {...S}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /><path d="M19.5 5.5a9 9 0 0 1 0 13" /></svg>,
  drop: <svg {...S}><path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" /></svg>,
  picture: <svg {...S}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-4.6-4.6a2 2 0 0 0-2.8 0L5 19" /></svg>,
  screen: <svg {...S}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>,
  download: <svg {...S}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></svg>,
  warning: <svg {...S}><path d="M12 3.5 22 20H2z" /><path d="M12 10v4.5" /><path d="M12 17.4h.01" /></svg>,
  lifebuoy: <svg {...S}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.6" /><path d="m5.6 5.6 3.9 3.9" /><path d="m14.5 14.5 3.9 3.9" /><path d="m18.4 5.6-3.9 3.9" /><path d="m9.5 14.5-3.9 3.9" /></svg>
}

const SCREENSAVER_LINE = {
  intro: 'The intro animation',
  photos: 'Family photos',
  corals: 'The coral journal',
  both: 'Corals and family photos',
  off: 'Off — the dashboard stays up'
}

// Section ids that are wizard steps carry that step's index; the rest are
// panels of their own. Keeping the mapping here means the wizard needs to know
// nothing about the hub.
const SECTIONS = [
  {
    id: 'wifi',
    step: 1,
    icon: 'wifi',
    title: 'Wi-Fi',
    // online === null means the check has not come back yet. Only an explicit
    // false earns "no internet"; the rest of the time the network name alone
    // is the honest answer.
    line: (s) => (s.wifi?.ssid ? `${s.wifi.ssid}${s.wifi.online === false ? ' — no internet' : ''}` : 'Not connected'),
    bad: (s) => !s.wifi?.ssid
  },
  { id: 'location', step: 2, icon: 'pin', title: 'Location', line: (s) => s.location ?? 'Not set — weather is guessing', bad: (s) => !s.location },
  { id: 'name', step: 3, icon: 'tag', title: 'Tank name', line: (s) => s.tankName ?? 'Not named yet — tap to name it', bad: (s) => !s.tankName },
  { id: 'apex', step: 4, icon: 'flask', title: 'Apex controller', line: (s) => s.apex ?? 'No controller set', bad: (s) => !s.apex },
  { id: 'dosing', icon: 'drop', title: 'Dosing', line: (s) => s.dosingMethod ?? 'Two-part' },
  {
    id: 'equipment',
    step: 5,
    icon: 'gear',
    title: 'Equipment',
    line: (s) => (!s.equipment?.enabled ? 'Switched off'
      : `Auto — ${s.equipment.seen ?? 0} found${s.equipment.hidden ? `, ${s.equipment.hidden} hidden` : ''}${s.equipment.manual ? `, ${s.equipment.manual} by address` : ''}`)
  },
  {
    id: 'alarms',
    icon: 'bell',
    title: 'Alarms & sounds',
    line: (s) => (s.alarms?.enabled === false ? 'Silent — no sound will play' : `Urgent: ${s.alarms?.urgentTone ?? 'siren'} · Warning: ${s.alarms?.warningTone ?? 'alert'}`),
    bad: (s) => s.alarms?.enabled === false
  },
  { id: 'photos', icon: 'picture', title: 'Photos', line: (s) => (s.photos ? `${s.photos} on the terminal` : 'None added yet') },
  {
    id: 'screensaver',
    icon: 'screen',
    title: 'Screensaver',
    line: (s) => {
      const what = SCREENSAVER_LINE[s.slideshow ?? 'intro'] ?? 'The intro animation'
      const after = s.slideshowIdle ?? 5
      if (s.slideshow === 'off') return what
      return after === 0 ? `${what} — never starts (timer off)` : `${what} · after ${after} min`
    }
  },
  { id: 'update', icon: 'download', title: 'Software update', line: () => 'Check for a newer version' },
  {
    id: 'support',
    icon: 'lifebuoy',
    title: 'Remote support',
    line: (s) => (s.support?.active ? `Open — code ${s.support.code ?? '…'}` : 'Let support look at this terminal'),
    bad: (s) => !!s.support?.active
  }
]

function Card({ section, summary, onOpen }) {
  const line = summary ? section.line(summary) : 'Checking…'
  const bad = summary && section.bad?.(summary)
  return (
    <button
      className={`hub-card ${bad ? 'attention' : ''}`}
      aria-label={`${section.title} — ${line}`}
      onClick={() => onOpen(section.id)}
    >
      <span className="hub-icon">{Ico[section.icon]}</span>
      <span className="hub-text">
        <b>{section.title}</b>
        <em>{line}</em>
      </span>
      <svg {...S} className="hub-chevron"><path d="m9 5 7 7-7 7" /></svg>
    </button>
  )
}

// Erasing everything deserves more than an "Are you sure?" — that question has
// been answered "yes" by everyone who ever meant "no". Typing the word is the
// cheapest way to make the hand agree with the head.
function ResetPanel({ onBack }) {
  const [typed, setTyped] = useState('')
  const [forgetWifi, setForgetWifi] = useState(false)
  const [kb, setKb] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const erase = async () => {
    setBusy(true)
    setError(null)
    try {
      await api('/api/setup/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'ERASE', forgetWifi })
      })
      setDone(true)
      await waitForServer({ timeoutMs: 60000 })
      window.location.replace('/')
    } catch (err) {
      setError(String(err.message ?? err))
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="setup-body">
        <h1>Erasing…</h1>
        <p>The terminal is starting over. Setup will appear in a moment.</p>
      </div>
    )
  }

  return (
    <div className="setup-body">
      <div className="setup-hero hub-danger">{Ico.warning}</div>
      <h1>Reset this terminal</h1>
      <p>
        This erases everything the household put in: your tank readings and their history,
        photos, the log and every setting. The terminal restarts as
        if it came out of the box, and setup runs again from the beginning.
      </p>
      <p className="setup-note">This cannot be undone, and nothing is backed up anywhere else.</p>

      <button className={`hub-toggle ${forgetWifi ? 'on' : ''}`} onClick={() => setForgetWifi((v) => !v)}>
        <b>Also forget Wi-Fi</b>
        <em>{forgetWifi
          ? 'The terminal will need a network chosen again on screen. Use this if you are selling or giving it away.'
          : 'Keeps this network so setup can reach the internet straight away.'}</em>
      </button>

      <input
        {...{ value: typed, readOnly: true, onClick: () => setKb(true), onFocus: () => setKb(true) }}
        className={kb ? 'setup-input focused' : 'setup-input'}
        placeholder="Type ERASE to confirm"
      />

      {error && <div className="setup-error">{error}</div>}
      <button className="setup-primary danger" disabled={typed.trim().toUpperCase() !== 'ERASE' || busy} onClick={erase}>
        Erase everything
      </button>
      <button className="setup-skip" onClick={onBack}>‹ Keep my settings</button>

      {kb && (
        <OnScreenKeyboard
          onKey={(c) => setTyped((v) => v + c)}
          onBackspace={() => setTyped((v) => v.slice(0, -1))}
          onSubmit={() => setKb(false)}
          onClose={() => setKb(false)}
          submitLabel="Done"
        />
      )}
    </div>
  )
}

export default function SettingsHub({ onExit }) {
  // ?settings=alarms opens straight into a section. Worth having beyond the
  // convenience: it gives anything on the dashboard a way to send you to the
  // exact setting it is complaining about, instead of to a list.
  const [unreachable, setUnreachable] = useState(false)
  const cardRef = useRef(null)
  useDragScroll(cardRef)
  const [open, setOpen] = useState(() => {
    const asked = new URLSearchParams(location.search).get('settings')
    return SECTIONS.some((s) => s.id === asked) ? asked : null
  })
  const [summary, setSummary] = useState(null)

  // A failed fetch used to become `{}`, and `{}` renders exactly like a
  // brand-new terminal: "Not connected", "Not set", "No controller set" —
  // every one of them a confident statement about settings that were saved
  // minutes earlier. Not knowing and knowing-it-is-empty are different, and
  // the cards now say so.
  const load = () =>
    api('/api/setup/summary')
      .then((d) => { setSummary(d); setUnreachable(false) })
      .catch(() => setUnreachable(true))

  useEffect(() => { load() }, [])

  // Keep trying while the service is down — the usual reason is that it is
  // restarting after a save, and it comes back within a couple of seconds.
  useEffect(() => {
    if (!unreachable) return
    let live = true
    ;(async () => {
      await waitForServer()
      if (live) load()
    })()
    return () => { live = false }
  }, [unreachable]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => { setOpen(null); load() }

  // Wizard-owned sections: hand the wizard the step and let it draw itself.
  const section = SECTIONS.find((s) => s.id === open)
  if (section?.step != null) {
    return <SetupWizard reconfigure section={section.step} onExit={back} />
  }
  if (open === 'photos') return <PhotoManager onClose={back} />

  // Settings panels are taller than the card on this screen, and nothing on
  // this panel scrolls by itself — the touchscreen arrives as a mouse.
  //
  // Every panel ends in one bold button that takes you back to the list.
  // These panels save each tap as it happens, so the button has nothing left
  // to write; it is there because a screen full of choices with only a
  // small "‹ Settings" in the corner left people unsure whether they were
  // finished. (The wizard-owned sections have their own Save.)
  const panel = (title, body, label = 'Save') => (
    <div className="setup">
      <div className="setup-card" ref={cardRef}>
        {body}
        <div className="hub-save">
          <button className="setup-primary" onClick={back}>{label}</button>
        </div>
        <button className="setup-back" onClick={back}>‹ Settings</button>
      </div>
    </div>
  )

  if (open === 'alarms') return panel('Alarms', <AlarmSettings />)
  if (open === 'screensaver') return panel('Screensaver', <ScreensaverSettings />)
  if (open === 'dosing') return panel('Dosing', <DosingSettings />)
  if (open === 'update') return panel('Update', <div className="setup-body"><h1>Software update</h1><UpdatePanel /></div>, 'Done')
  if (open === 'support') return panel('Support', <SupportPanel />, 'Done')
  if (open === 'reset') {
    return (
      <div className="setup">
        <div className="setup-card"><ResetPanel onBack={back} /></div>
      </div>
    )
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="hub-head">
          <h1>Settings</h1>
          <button className="setup-primary compact" onClick={onExit}>Done</button>
        </div>

        {unreachable && !summary && (
          <div className="setup-note">Waiting for the terminal service to answer…</div>
        )}

        <div className="hub-grid">
          {SECTIONS.map((s) => <Card key={s.id} section={s} summary={summary} onOpen={setOpen} />)}
        </div>

        <div className="hub-foot">
          <button className="hub-danger-btn" onClick={() => setOpen('reset')}>
            {Ico.warning} Reset this terminal
          </button>
          <span className="setup-note">Erases everything and starts setup again.</span>
        </div>
      </div>
    </div>
  )
}
