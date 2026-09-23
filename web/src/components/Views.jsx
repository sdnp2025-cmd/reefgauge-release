import React, { useEffect, useState } from 'react'
import { usePolling } from '../api.js'
import { useTankName } from '../tankName.js'
import TankPanel, { FeedButton } from './TankPanel.jsx'
import EnvPanel from './EnvPanel.jsx'
import MaintList from './MaintList.jsx'
import WeatherPanel from './WeatherPanel.jsx'
import ReefAquarium from './ReefAquarium.jsx'

// The full aquarium (bubbles, rays, drifting plates) is too dear for the Pi 4
// to run all day, but it is what the product videos want; ?fullreef turns it
// on for a capture session without touching the shipped default.
const FULL_REEF = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('fullreef')
import RedSeaPanel from './RedSeaPanel.jsx'

// Full-screen section views for the 10" display, reached from the home cards.

export function DetailView({ title, onBack, action, children, className = '' }) {
  return (
    <div className={`view ${className}`}>
      <div className="view-bar">
        <button className="view-back" onClick={onBack}>‹ Home</button>
        <span className="view-title">{title}</span>
        <span className="view-action">{action}</span>
      </div>
      <div className="view-body">{children}</div>
    </div>
  )
}

// View titles carry a glyph, and it has to be drawn rather than typed: the Pi
// image has no colour-emoji font, so 📅 and friends arrive on the wall as an
// empty box. Same rule as everywhere else on the kiosk.
const G = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'view-glyph' }
const FishGlyph = () => (
  <svg {...G}><path d="M6.5 12c1.8-3.2 5-5 8.5-5 2.5 0 4.8 1 6.5 2.7-1.7 4-5 6.3-8.5 6.3-2.5 0-4.8-1-6.5-2.7z" /><path d="M6.5 12 2 8.5v7z" /><circle cx="16.5" cy="11" r="0.6" fill="currentColor" /></svg>
)
const BreezeGlyph = () => (
  <svg {...G}><path d="M3 8h11a3 3 0 1 0-3-3" /><path d="M3 12h15a3 3 0 1 1-3 3" /><path d="M3 16h8" /></svg>
)

export function TankView({ onBack, onEquipment }) {
  const name = useTankName()
  return (
    <DetailView title={<><FishGlyph /> {name}</>} onBack={onBack} action={<FeedButton />} className="view-tank">
      <div className="panel tank-panel view-tank-panel">
        <ReefAquarium lite={!FULL_REEF} />
        <TankPanel />
      </div>
      <RedSeaPanel onOpen={onEquipment} />
    </DetailView>
  )
}


export function WeatherView({ onBack, onRadar }) {
  return (
    <DetailView
      title="Weather"
      onBack={onBack}
      action={<button className="view-btn" onClick={onRadar}>Radar ›</button>}
    >
      <WeatherPanel variant="forecast" onOpenRadar={onRadar} />
    </DetailView>
  )
}

export function AirView({ onBack }) {
  return (
    <DetailView title={<><BreezeGlyph /> Room Air &amp; Maintenance</>} onBack={onBack}>
      <div className="panel view-fill">
        <EnvPanel />
        <MaintList />
      </div>
    </DetailView>
  )
}
