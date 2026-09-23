import React, { useState } from 'react'

// Touch keyboard for the kiosk (the Pi has no OS keyboard in Chromium kiosk
// mode). This is the ONLY way to type on the terminal, so it has to cover
// everything the setup wizard and the family panels ask for: Wi-Fi passwords
// (mixed case and symbols), URLs and IP addresses.
// Hidden on phones, where the native keyboard is better.

const LAYOUTS = {
  abc: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  sym: ['1234567890', '!@#$%^&*()', '-_=+[]{}|\\', ';:\'",.?/~`']
}

export default function OnScreenKeyboard({ onKey, onBackspace, onSubmit, onClose, submitLabel = 'Add' }) {
  const [layer, setLayer] = useState('abc')
  const [shift, setShift] = useState('off') // off → once → lock → off

  const shifted = layer === 'abc' && shift !== 'off'

  const press = (k) => {
    const isLetter = /[a-z]/.test(k)
    onKey(shifted && isLetter ? k.toUpperCase() : k)
    if (shift === 'once') setShift('off') // one-shot, like a phone keyboard
  }

  return (
    <div className="osk">
      {LAYOUTS[layer].map((row) => (
        <div key={row} className="osk-row">
          {[...row].map((k) => (
            <button key={k} className="osk-key" onClick={() => press(k)}>
              {shifted && /[a-z]/.test(k) ? k.toUpperCase() : k}
            </button>
          ))}
        </div>
      ))}
      <div className="osk-row">
        {layer === 'abc' && (
          <button
            className={`osk-key osk-mod ${shift !== 'off' ? 'active' : ''}`}
            onClick={() => setShift((s) => (s === 'off' ? 'once' : s === 'once' ? 'lock' : 'off'))}
          >
            {shift === 'lock' ? 'CAPS' : 'Shift'}
          </button>
        )}
        <button className="osk-key osk-mod" onClick={() => setLayer((l) => (l === 'abc' ? 'sym' : 'abc'))}>
          {layer === 'abc' ? '?#+' : 'ABC'}
        </button>
        <button className="osk-key osk-space" onClick={() => press(' ')}>space</button>
        <button className="osk-key" onClick={onBackspace}>⌫</button>
        <button className="osk-key osk-close" onClick={onClose}>✕</button>
        <button className="osk-key osk-add" onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  )
}
