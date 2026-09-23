import React, { useEffect, useRef, useState } from 'react'
import { usePolling } from '../api.js'
import BootSplash from './BootSplash.jsx'

const SLIDE_MS = 12 * 1000

// After a while without touch - how long is a setting, five minutes unless
// changed, "off" never - the screen gives itself over to something else.
// What that is, is a setting too: the intro animation on a loop (the
// default - it needs no pictures and it is the brand), the coral journal,
// family photos, or both kinds of photo. The journal is the good answer
// once there are photos in it: they are of the thing the screen is bolted
// next to, and they arrive named and dated.
export default function IdleSlideshow() {
  const [data] = usePolling('/api/slideshow', 60000)
  const [idle, setIdle] = useState(false)
  const [index, setIndex] = useState(0)
  const images = data?.images ?? []
  const source = data?.source ?? 'intro'
  // The timer reads the delay through a ref so a changed setting takes
  // effect on the next tick without re-arming the listeners.
  const idleMs = (data?.idleMinutes ?? 5) * 60 * 1000
  const idleMsRef = useRef(idleMs)
  useEffect(() => {
    idleMsRef.current = idleMs
    if (idleMs === 0) setIdle(false)
  }, [idleMs])

  useEffect(() => {
    let last = Date.now()
    const activity = () => { last = Date.now(); setIdle(false) }
    const check = setInterval(() => {
      // An unacknowledged alert must never be hidden behind photographs.
      if (document.body.classList.contains('has-alert')) { last = Date.now(); setIdle(false); return }
      if (idleMsRef.current > 0 && Date.now() - last >= idleMsRef.current) setIdle(true)
    }, 5000)
    window.addEventListener('pointerdown', activity)
    window.addEventListener('keydown', activity)
    return () => {
      clearInterval(check)
      window.removeEventListener('pointerdown', activity)
      window.removeEventListener('keydown', activity)
    }
  }, [])

  // Let the stylesheet know: the aquarium pauses itself while it is covered.
  const showing = idle && (source === 'intro' || images.length > 0)
  useEffect(() => {
    document.body.classList.toggle('is-idle', showing)
    return () => document.body.classList.remove('is-idle')
  }, [showing])

  useEffect(() => {
    if (!idle || images.length < 2) return
    const id = setInterval(() => setIndex((i) => (i + 1) % images.length), SLIDE_MS)
    return () => clearInterval(id)
  }, [idle, images.length])

  if (!showing) return null
  if (source === 'intro') {
    return (
      <div className="slideshow slideshow-intro">
        <BootSplash loop />
      </div>
    )
  }
  const image = images[index % images.length]

  return (
    <div className="slideshow">
      <img key={image.id} src={image.url} alt="" />
      {image.caption && <div className="slideshow-caption">{image.caption}</div>}
      <div className="slideshow-clock">
        {new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
    </div>
  )
}
