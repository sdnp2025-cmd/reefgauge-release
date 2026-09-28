import { performance } from 'node:perf_hooks'

// The wall clock on this machine is not monotonic, and on a Pi it is wrong at
// every boot.
//
// A Raspberry Pi 4 has no real-time clock. There is no battery and no /dev/rtc,
// so when it powers up it has no idea what time it is; systemd restores the
// last time it saw and the machine runs on that until NTP answers. On this unit
// that gap has been measured at twenty hours: booted, believed it was the
// previous evening, ran for forty seconds, then jumped forward.
//
// Every "how old is this reading" in the product is `Date.now() - ts`, and that
// arithmetic is only meaningful if the clock has not moved underneath it. When
// it moves, a reading taken three seconds ago reads as twenty hours old - and
// the terminal does exactly what it is supposed to do about a reading twenty
// hours old. It sounds the alarm, puts APEX OFFLINE on the wall, and texts the
// owner. Nothing is wrong with the tank, the controller or the network. The
// clock moved.
//
// So: watch for the clock being stepped, and tell the rest of the program when
// it happens, so it can correct what it believed and go and look again.

const CHECK_MS = 1000

// Below this, it is NTP slewing the clock gently (which is fine - everything
// stays roughly true) or ordinary timer jitter under load. A step large enough
// to matter is seconds, and the one this exists for is hours.
const STEP_MS = 5000

let wallBase = Date.now()
let monoBase = performance.now()
const listeners = []

/// Milliseconds since this process started, from a monotonic source.
///
/// Use this, never `Date.now() - startedAt`, for "have we been running long
/// enough to judge anything". A wall-clock uptime is exactly as wrong as the
/// clock, so a startup grace period computed that way is skipped entirely by
/// the jump it exists to survive.
export function uptimeMs() {
  return performance.now()
}

/// Called with the step in milliseconds (positive when the clock jumped
/// forward). Listeners should correct any wall-clock timestamps they are
/// holding, and re-read anything whose freshness matters.
export function onClockStep(fn) {
  listeners.push(fn)
}

/// Shifts a stored wall-clock timestamp by a step, so that "how long ago" still
/// answers the same thing it did a moment earlier. Passes null through, because
/// most of these are "never happened yet" until they are not.
export function shift(ts, deltaMs) {
  return ts == null ? ts : ts + deltaMs
}

export function startClockWatch(log = console, { checkMs = CHECK_MS } = {}) {
  const timer = setInterval(() => {
    const mono = performance.now()
    const expected = wallBase + (mono - monoBase)
    const delta = Date.now() - expected
    if (Math.abs(delta) < STEP_MS) return

    // Re-base first. A listener that throws must not leave this detecting the
    // same step over and over on every tick afterwards.
    wallBase = Date.now()
    monoBase = mono

    const seconds = Math.round(delta / 1000)
    log.warn?.(`system clock stepped ${seconds > 0 ? '+' : ''}${seconds}s `
      + '- correcting stored timestamps and re-reading')

    for (const fn of listeners) {
      try {
        fn(delta)
      } catch (err) {
        log.warn?.(`clock-step handler failed: ${err.message}`)
      }
    }
  }, checkMs)
  // Nothing should stay alive just to watch the clock.
  timer.unref?.()
  return timer
}
