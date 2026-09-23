// Audible alarms through the panel's own speakers.
//
// Deliberately server-side rather than in the browser. The kiosk already
// chimes for kitchen timers via Web Audio, which is fine for a timer: if the
// browser is dead nobody cares about the pasta. An alarm is the opposite —
// "the Apex stopped reporting" matters most in exactly the situations where
// the display may also have fallen over, so it must not depend on Chromium
// being alive to make a sound.
//
// The tone is generated rather than shipped as a file: a WAV is a 44-byte
// header and raw samples, and generating it keeps the pitch and pattern
// editable in code instead of locked inside a binary nobody can inspect.

import { spawn } from 'node:child_process'

// Five sounds, ordered by how hard they are to ignore. A household picks the
// one that fits the room: a nursery wants the chime, a garage wants the
// klaxon, and the same alarm in the wrong register either gets missed or gets
// switched off — both of which end with nobody being told about the tank.
//
// A note is [frequency Hz, milliseconds]; 0 Hz is a rest. `timbre` decides how
// the note is drawn: a sine is round and pleasant, and a square is buzzy and
// carries further through a closed door, which is most of what separates the
// gentle end of this list from the harsh one.
export const SOUNDS = {
  chime: {
    label: 'Chime',
    note: 'Three rising notes, soft. Pleasant enough to live with.',
    timbre: 'sine',
    notes: [[1047, 220], [0, 40], [1319, 220], [0, 40], [1568, 560]]
  },
  ping: {
    label: 'Ping',
    note: 'A falling pair, twice. Reads as "look at me", not "run".',
    timbre: 'sine',
    notes: [[1568, 130], [0, 70], [1175, 260], [0, 180], [1568, 130], [0, 70], [1175, 320]]
  },
  alert: {
    label: 'Alert',
    note: 'Two tones alternating, buzzer register. Mechanical, not musical.',
    timbre: 'square',
    amplitude: 0.3,
    notes: [[988, 160], [659, 160], [988, 160], [659, 160], [988, 160], [659, 260]]
  },
  siren: {
    label: 'Siren',
    note: 'Three fast rising sweeps. Emergency-vehicle whoop.',
    timbre: 'square',
    amplitude: 0.3,
    notes: [[500, 380, 1500], [0, 60], [500, 380, 1500], [0, 60], [500, 460, 1600]]
  },
  klaxon: {
    label: 'Klaxon',
    note: 'Sawtooth sweeps, high and chopped, for three and a half seconds.',
    timbre: 'saw',
    amplitude: 0.42,
    notes: [
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [0, 40],
      [1500, 190, 3400], [0, 40], [1500, 190, 3400], [1500, 240, 3400]
    ]
  }
}

const RATE = 22050          // plenty for a beep, and a quarter the bytes of 44.1k
const AMPLITUDE = 0.28      // headroom: a clipped square-ish tone sounds broken

// Timbre is most of what separates the gentle end of the list from the harsh
// one. Both harsh shapes are built from harmonics rather than a hard sign()
// flip, which gives the buzz without the aliasing screech that makes a small
// speaker rattle instead of getting louder.
function wave(timbre, phase) {
  if (timbre === 'square') {          // odd harmonics only: hollow, buzzy
    return (
      Math.sin(phase) +
      Math.sin(3 * phase) / 3 +
      Math.sin(5 * phase) / 5 +
      Math.sin(7 * phase) / 7
    ) / 1.28
  }
  if (timbre === 'saw') {             // every harmonic: brighter and nastier
    let v = 0
    for (let n = 1; n <= 9; n++) v += Math.sin(n * phase) / n
    return v / 1.9
  }
  return Math.sin(phase)
}

function toneBuffer({ notes, timbre = 'sine', amplitude = AMPLITUDE }) {
  const samples = []
  // Phase carries across notes so a glide has no click at the joins: a siren
  // is one continuous tone changing pitch, not a row of separate beeps.
  let phase = 0
  for (const [freq, ms, toFreq] of notes) {
    const count = Math.round((RATE * ms) / 1000)
    for (let i = 0; i < count; i++) {
      if (freq === 0) { samples.push(0); phase = 0; continue }
      // A third value sweeps the note from freq to toFreq.
      const f = toFreq ? freq + (toFreq - freq) * (i / count) : freq
      phase += (2 * Math.PI * f) / RATE
      // Fade both ends of a held note; a sweep runs into its neighbour, so
      // fading it would chop the very continuity that makes it a sweep.
      const attack = Math.min(1, i / (RATE * 0.008))
      const release = toFreq ? 1 : Math.min(1, (count - i) / (RATE * 0.02))
      samples.push(wave(timbre, phase) * attack * release * amplitude)
    }
  }

  const data = Buffer.alloc(samples.length * 2)
  // Clamp rather than wrap: a sample past full scale must flatten, not fold
  // over into a different waveform, which is what turns grit into garbage.
  samples.forEach((v, i) => {
    const clamped = Math.max(-1, Math.min(1, v))
    data.writeInt16LE(Math.round(clamped * 32767), i * 2)
  })

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          // PCM chunk size
  header.writeUInt16LE(1, 20)           // format: PCM
  header.writeUInt16LE(1, 22)           // channels: mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)    // byte rate
  header.writeUInt16LE(2, 32)           // block align
  header.writeUInt16LE(16, 34)          // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// Cache: the same few buffers are played over and over.
const cache = new Map()
function wav(name) {
  if (!cache.has(name)) cache.set(name, toneBuffer(SOUNDS[name] ?? SOUNDS.alert))
  return cache.get(name)
}

// The panel's speakers hang off HDMI. plughw converts sample rates for us, so
// the tone does not have to match whatever the display negotiated.
const DEFAULT_DEVICE = 'plughw:0,0'

let playing = false

export function alarmConfig(config) {
  const sound = config.alerts?.sound ?? {}
  return {
    enabled: sound.enabled !== false,          // on unless switched off
    device: sound.device || DEFAULT_DEVICE,
    // How long an alarm keeps repeating before it gives up, and how long it
    // waits between repeats. Bounded on purpose: an alarm that repeats forever
    // gets the speaker unplugged, and then it is not an alarm any more.
    loopMinutes: sound.loopMinutes ?? 10,
    loopGapSeconds: sound.loopGapSeconds ?? 4,
    // Warnings keep quiet overnight; urgent alarms never do. A tank losing
    // its controller at 3am is the case the whole feature exists for.
    quietFrom: sound.quietFrom ?? 22,
    quietTo: sound.quietTo ?? 7,
    // Two choices, because the two alarms mean different things. Urgent should
    // be able to cut through a room that warnings are allowed to sit politely
    // in the corner of.
    urgentTone: SOUNDS[sound.urgentTone] ? sound.urgentTone : 'siren',
    warningTone: SOUNDS[sound.warningTone] ? sound.warningTone : 'alert'
  }
}

function inQuietHours({ quietFrom, quietTo }, now = new Date()) {
  const hour = now.getHours()
  if (quietFrom === quietTo) return false
  return quietFrom < quietTo
    ? hour >= quietFrom && hour < quietTo
    : hour >= quietFrom || hour < quietTo      // window wraps midnight
}

// Returns true when a sound was actually started, so callers can record it.
export function playAlarm(config, priority) {
  const settings = alarmConfig(config)
  if (!settings.enabled) return false

  const urgent = priority === 'urgent'
  if (!urgent && inQuietHours(settings)) return false

  // One at a time. Two overlapping alarms on one small speaker is noise, not
  // information, and aplay would fight for the device anyway.
  if (playing) return false
  playing = true

  try {
    const proc = spawn('aplay', ['-q', '-D', settings.device, '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    proc.on('error', () => { playing = false })
    proc.on('close', () => { playing = false })
    proc.stdin.on('error', () => { playing = false })   // device busy or absent
    proc.stdin.end(wav(urgent ? settings.urgentTone : settings.warningTone))
    return true
  } catch {
    playing = false
    return false
  }
}

// Play a named sound on demand — for choosing one, where quiet hours and the
// urgent/warning distinction do not apply because a person is standing there
// asking to hear it.
export function playTone(config, name) {
  const settings = alarmConfig(config)
  if (!SOUNDS[name]) return false
  if (playing) return false
  playing = true
  try {
    const proc = spawn('aplay', ['-q', '-D', settings.device, '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    proc.on('error', () => { playing = false })
    proc.on('close', () => { playing = false })
    proc.stdin.on('error', () => { playing = false })
    proc.stdin.end(wav(name))
    return true
  } catch {
    playing = false
    return false
  }
}
