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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

createRoot(document.getElementById('root')).render(<App />)
