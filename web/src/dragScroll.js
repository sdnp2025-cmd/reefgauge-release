import { useEffect } from 'react'

// Drag-to-scroll, done in the app rather than left to the browser.
//
// The panel's touchscreen does not reach Chromium as a touchscreen. Measured on
// the running kiosk while a finger swiped: 1474 input events, every one of them
// pointerType "mouse", and not a single touchstart. The compositor emulates a
// pointer from the panel, so the browser sees a mouse being dragged — and a
// mouse drag scrolls nothing, which is why a list with 300px of overflow sat
// still under a finger.
//
// Chromium's own touch scrolling would be better: it brings momentum, rubber
// banding and rejection of accidental drags for free. Getting it would mean
// changing how the compositor hands input over, which is a system-level fix on
// a box this code does not administer. This works with what actually arrives.
export function useDragScroll(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let startY = 0
    let startTop = 0
    let lastY = 0
    let lastT = 0
    let velocity = 0
    let dragging = false
    let moved = false
    let glide = 0

    // A press has to travel before it becomes a scroll, or every tap on a
    // meter would nudge the list by a pixel or two.
    const SLOP = 6

    const down = (e) => {
      if (e.button != null && e.button !== 0) return
      cancelAnimationFrame(glide)
      dragging = true
      moved = false
      velocity = 0
      startY = lastY = e.clientY
      lastT = e.timeStamp
      startTop = el.scrollTop
    }

    const move = (e) => {
      if (!dragging) return
      const dy = e.clientY - startY
      if (!moved && Math.abs(dy) < SLOP) return
      moved = true
      const dt = e.timeStamp - lastT
      if (dt > 0) velocity = (e.clientY - lastY) / dt      // px per ms
      lastY = e.clientY
      lastT = e.timeStamp
      el.scrollTop = startTop - dy
      // Stops the drag turning into a text selection, which is what a mouse
      // drag across a page means to a browser.
      e.preventDefault()
    }

    const up = () => {
      if (!dragging) return
      dragging = false
      if (!moved) return
      // A flick keeps going and slows down. Without it, dragging a long list
      // means a dozen separate swipes.
      let v = velocity
      const step = () => {
        v *= 0.94
        if (Math.abs(v) < 0.02) return
        el.scrollTop -= v * 16
        glide = requestAnimationFrame(step)
      }
      glide = requestAnimationFrame(step)
    }

    // A drag that ends outside the element still has to end, so movement and
    // release are watched on the window.
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      cancelAnimationFrame(glide)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [ref])
}
