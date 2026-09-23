import React, { useState } from 'react'
import { createPortal } from 'react-dom'

// Type an amount and commit it.
//
// The on-screen keyboard is a full QWERTY and wrong for this: entering "12" on
// a wet touchscreen should be two taps on big targets, not a hunt across forty
// small ones. Keys are sized for a finger, the value is large enough to check
// from standing, and Enter is the only thing that writes anything.

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

export default function Keypad({ title, subtitle, unit, initial, onCommit, onClose }) {
  // Starts with the usual amount already typed, so the common case is one tap
  // on Enter. The first digit pressed replaces it rather than appending to it.
  const [text, setText] = useState(initial != null ? String(initial) : '')
  const [fresh, setFresh] = useState(true)

  const press = (k) => {
    if (k === '⌫') {
      setFresh(false)
      setText((t) => t.slice(0, -1))
      return
    }
    if (k === '.' && text.includes('.')) return
    setText((t) => {
      const base = fresh ? '' : t
      if (base.replace('.', '').length >= 6) return base
      return base + k
    })
    setFresh(false)
  }

  const value = Number(text)
  const valid = text !== '' && text !== '.' && Number.isFinite(value) && value > 0

  return createPortal(
    // Its own z-index rather than relying on mount order: the keypad opens
    // from on top of the history chart, and both are overlays.
    <div className="overlay keypad-overlay" onClick={onClose}>
      <div className="keypad" onClick={(e) => e.stopPropagation()}>
        <div className="keypad-head">
          <div className="keypad-title">
            <b>{title}</b>
            {subtitle && <em>{subtitle}</em>}
          </div>
          <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={`keypad-value ${valid ? '' : 'empty'}`}>
          <span>{text || '0'}</span>
          <em>{unit}</em>
        </div>

        <div className="keypad-keys">
          {KEYS.map((k) => (
            <button key={k} className={`keypad-key ${k === '⌫' ? 'wide-glyph' : ''}`} onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>

        <div className="keypad-foot">
          <button className="keypad-enter" disabled={!valid} onClick={() => onCommit(value)}>
            Enter
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
