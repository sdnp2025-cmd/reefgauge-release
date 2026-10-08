import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// PWA: capture ?token= for API auth, register the service worker
const params = new URLSearchParams(location.search)
if (params.get('token')) {
  try { localStorage.setItem('rt_token', params.get('token')) } catch {}
  params.delete('token')
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''))
}
// The service worker is for phones, where it makes the app open instantly and
// survive a dropped connection. On the wall unit it is harmful: it caches
// every GET and never evicts, and the kiosk's profile lives in a tmpfs of
// about a tenth of RAM (pi/kiosk.sh), so over days of polling and an update's
// new bundle the store fills and Chromium puts up "Free up space to continue".
// The kiosk loads from localhost and never needs offline; it gets no worker,
// and one left by an earlier build is removed along with what it cached.
const kiosk = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
if ('serviceWorker' in navigator) {
  if (kiosk) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {})
    if (window.caches) caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {})
  } else {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

createRoot(document.getElementById('root')).render(<App />)
