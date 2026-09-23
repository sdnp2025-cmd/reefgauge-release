import React, { useEffect, useState } from 'react'
import Clock from './components/Clock.jsx'
import WeatherPanel from './components/WeatherPanel.jsx'
import HomeCards from './components/HomeCards.jsx'
import TankLogView from './components/TankLogView.jsx'
import IcpView from './components/IcpView.jsx'
import CoralsView from './components/CoralsView.jsx'
import AirTicker from './components/AirTicker.jsx'
import EquipmentOverlay from './components/EquipmentOverlay.jsx'
import { TankView, WeatherView, AirView } from './components/Views.jsx'
import PhotoManager from './components/PhotoManager.jsx'
import IdleSlideshow from './components/IdleSlideshow.jsx'
import RadarOverlay from './components/RadarOverlay.jsx'
import DoorbellOverlay from './components/DoorbellOverlay.jsx'
import SetupWizard from './components/SetupWizard.jsx'
import SettingsHub from './components/SettingsHub.jsx'
import WeatherGallery from './components/WeatherGallery.jsx'
import IcpCardGallery from './components/IcpCardGallery.jsx'
import LogStyleGallery from './components/LogStyleGallery.jsx'
import PhoneSetup from './components/PhoneSetup.jsx'
import { TimerBar, TimerPicker } from './components/TimerBar.jsx'
import BootSplash, { wantsSplash } from './components/BootSplash.jsx'
import AlertCard from './components/AlertCard.jsx'
import { useTankName } from './tankName.js'
import { usePolling } from './api.js'

// Night runs from local sunset to sunrise (from the weather API), with a
// clock fallback before the first fetch. ?mode=day|night forces it for testing.
function useNightMode(enabled = true) {
  const [weather] = usePolling(enabled ? '/api/weather' : null, 10 * 60 * 1000)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  const forced = new URLSearchParams(location.search).get('mode')
  let night
  if (forced) {
    night = forced === 'night'
  } else if (weather?.sun?.sunrise && weather?.sun?.sunset) {
    night = now < new Date(weather.sun.sunrise).getTime() || now > new Date(weather.sun.sunset).getTime()
  } else {
    const hour = new Date(now).getHours()
    night = hour < 7 || hour >= 19
  }

  useEffect(() => {
    document.documentElement.dataset.mode = night ? 'night' : 'day'
  }, [night])

  return night
}

// The tank's name in the header, between the date and the gear.
// The tank's name, lettered like the logo. Three stacked copies of the
// same text: the back one is the navy edge, the middle one the white
// outline, the front one the blue gradient fill - CSS cannot stroke
// outside a gradient-filled glyph in one pass. Long names shrink so the
// header never clips them: full size to 14 characters, about 60% at 40.
function TankName() {
  const name = useTankName()
  const scale = Math.max(0.6, Math.min(1, 1 - (name.length - 14) * 0.016))
  return (
    <div className="header-tank" style={{ '--name-scale': scale }} aria-label={name}>
      <span className="tank-word tank-word-edge" aria-hidden="true">{name}</span>
      <span className="tank-word tank-word-outline" aria-hidden="true">{name}</span>
      <span className="tank-word tank-word-fill">{name}</span>
    </div>
  )
}

export default function App() {
  // A phone that scanned the terminal's QR gets the hand-off page, not the
  // kiosk — decided before anything else so the dashboard's pollers never run
  // on a device that has no token for them.
  const phoneHandoff = new URLSearchParams(location.search).has('rt')
  // ?view=log opens a detail screen directly. Worth having beyond the
  // convenience of checking one: it gives an alert somewhere on the dashboard
  // a way to send you to the screen it is complaining about.
  const VIEWS = ['tank', 'weather', 'air', 'log', 'icp', 'corals']
  const [view, setView] = useState(() => {
    const asked = new URLSearchParams(location.search).get('view')
    return VIEWS.includes(asked) ? asked : 'home'
  })
  const [booting, setBooting] = useState(() => !phoneHandoff && wantsSplash())
  const [photosOpen, setPhotosOpen] = useState(false)
  const [radarOpen, setRadarOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  const [equipOpen, setEquipOpen] = useState(false)
  const [setupStatus, setSetupStatus] = useState(null)
  // ?setup=1 forces the whole first-run wizard (used from a shell, and by the
  // wizard's own reload); ?settings=1 comes back from a section that saved.
  const [wizardOpen, setWizardOpen] = useState(new URLSearchParams(location.search).has('setup'))
  const [settingsOpen, setSettingsOpen] = useState(new URLSearchParams(location.search).has('settings'))
  useNightMode(!phoneHandoff) // sets data-mode=day|night on <html>; CSS does the rest

  useEffect(() => {
    if (phoneHandoff) return
    fetch('/api/setup/status').then((r) => r.json()).then(setSetupStatus).catch(() => setSetupStatus({ complete: true }))
  }, [phoneHandoff])

  // The nonce in ?rt= decides what the phone page can do, so this branch is
  // deliberately dumb — the server answers that question, not the query string.
  if (phoneHandoff) return <PhoneSetup />

  // Design scratch pad: every sky at once.
  if (new URLSearchParams(location.search).has('weather')) return <WeatherGallery />
  if (new URLSearchParams(location.search).has('icpcards')) return <IcpCardGallery />
  if (new URLSearchParams(location.search).has('logstyles')) return <LogStyleGallery />

  // First boot (or ?setup=1 / the ⚙️ button): full-screen setup wizard
  if (setupStatus && !setupStatus.complete) {
    return <SetupWizard />
  }
  if (wizardOpen) {
    return <SetupWizard reconfigure onExit={() => { setWizardOpen(false); history.replaceState(null, '', '/') }} />
  }
  // The gear opens the settings list, not the wizard. Sending someone back
  // through Wi-Fi and their own postcode to change a wake word was the whole
  // complaint.
  if (settingsOpen) {
    return <SettingsHub onExit={() => { setSettingsOpen(false); history.replaceState(null, '', '/') }} />
  }

  const home = () => setView('home')

  return (
    <div className="app">
      {booting && <BootSplash onDone={() => setBooting(false)} />}
      <header className="header">
        <Clock onClick={() => setTimerOpen(true)} />
        <TankName />
        <div className="header-right">
          <button className="photos-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h.1a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
          </button>
          <button className="photos-btn" onClick={() => setPhotosOpen(true)} aria-label="Manage photos">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-4.6-4.6a2 2 0 0 0-2.8 0L5 19" /></svg>
          </button>
          <WeatherPanel variant="current" />
        </div>
      </header>
      <main className="body-area">
        <AlertCard />
        {view === 'home' && <HomeCards onOpen={setView} />}
        {view === 'tank' && <TankView onBack={home} onEquipment={() => setEquipOpen(true)} />}
        {view === 'weather' && <WeatherView onBack={home} onRadar={() => setRadarOpen(true)} />}
        {view === 'air' && <AirView onBack={home} />}
        {view === 'log' && <TankLogView onBack={home} onOpen={setView} />}
        {view === 'icp' && <IcpView onBack={home} />}
        {view === 'corals' && <CoralsView onBack={home} />}
      </main>
      <AirTicker onOpen={(t) => (t === 'equipment' ? setEquipOpen(true) : setView(t))} />
      {equipOpen && <EquipmentOverlay onClose={() => setEquipOpen(false)} />}
      {photosOpen && <PhotoManager onClose={() => setPhotosOpen(false)} />}
      {radarOpen && <RadarOverlay onClose={() => setRadarOpen(false)} />}
      {timerOpen && <TimerPicker onClose={() => setTimerOpen(false)} />}
      <TimerBar />
      <IdleSlideshow />
      <DoorbellOverlay />
    </div>
  )
}
