import React, { useEffect, useState } from 'react'

// The boot animation: what the screen does between Chromium coming up and the
// dashboard being ready. About three seconds - deep water, the logo rises and
// settles, bubbles, one shaft of light across it, the water lightens, and the
// whole thing dissolves into the dashboard. Transform and opacity only, and
// the component unmounts when it is done, so it costs nothing afterward.
//
// It waits for the server as well as the clock: the dashboard is only shown
// once /api/health answers, so a slow boot shows the logo for longer rather
// than an empty page. Deep links (?view=, ?settings=) skip it - those are for
// screenshots and tests, not a person walking up to the wall.

const MIN_MS = 3000        // the animation's own length
const FADE_MS = 700
const LOOP_MS = 6500       // as a screensaver: rise, settle, hold, dissolve, again
const BUBBLES = [
  // x%, size px, duration s, delay s, drift px
  [14, 10, 4.2, 0.0, 18], [26, 6, 5.0, 0.8, -12], [41, 14, 3.6, 0.3, 22],
  [58, 8, 4.6, 1.1, -16], [73, 12, 3.9, 0.5, 14], [86, 7, 5.2, 0.2, -20],
]

export function wantsSplash() {
  const q = new URLSearchParams(location.search)
  return !q.has('view') && !q.has('settings') && !q.has('rt') && !q.has('nosplash') && !q.has('alertdemo')
}

// With `loop`, it is the screensaver: the same animation, dissolving and
// starting over every few seconds until something is touched. No server
// wait, no onDone - the idle screen unmounts it.
export default function BootSplash({ onDone, loop = false }) {
  const [phase, setPhase] = useState('in')     // in -> out -> gone
  const [round, setRound] = useState(0)        // remount key while looping

  useEffect(() => {
    let alive = true
    if (loop) {
      const t1 = setTimeout(() => { if (alive) setPhase('out') }, LOOP_MS - FADE_MS)
      const t2 = setTimeout(() => { if (alive) { setPhase('in'); setRound((r) => r + 1) } }, LOOP_MS)
      return () => { alive = false; clearTimeout(t1); clearTimeout(t2) }
    }
    const server = fetch('/api/health').then(() => true).catch(() => true)
    const clock = new Promise((r) => setTimeout(r, MIN_MS))
    Promise.all([server, clock]).then(() => {
      if (!alive) return
      setPhase('out')
      setTimeout(() => { if (alive) { setPhase('gone'); onDone?.() } }, FADE_MS)
    })
    return () => { alive = false }
  }, [onDone, loop, round])

  if (phase === 'gone') return null
  return (
    <div key={round} className={`boot ${phase === 'out' ? 'boot-out' : ''} ${loop ? 'boot-loop' : ''}`} aria-hidden="true">
      <div className="boot-water" />
      <div className="boot-shaft" />
      {BUBBLES.map(([x, s, d, delay, drift], i) => (
        <span key={i} className="boot-bubble"
          style={{ left: `${x}%`, width: s, height: s,
                   animationDuration: `${d}s`, animationDelay: `${delay}s`,
                   '--drift': `${drift}px` }} />
      ))}
      <img className="boot-logo" src="/brand/reefgauge-logo-600.png" alt="" draggable="false" />
      <div className="boot-line"><span /></div>
    </div>
  )
}
