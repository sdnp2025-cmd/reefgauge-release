import React from 'react'

// Maps an Open-Meteo weather code to one of the app's drawn condition scenes.
// Freezing rain gets its own "ice" scene rather than riding with plain rain.
export function glyphKind(code) {
  if ([95, 96, 99].includes(code)) return 'storm'
  if ([66, 67].includes(code)) return 'ice'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return 'rain'
  if ([45, 48].includes(code)) return 'fog'
  if (code === 3) return 'cloudy'
  if ([1, 2].includes(code)) return 'partly'
  return 'clear'
}

// Inline SVG condition scene. Colors come from theme tokens (wxg-* classes in
// styles.css) so glyphs stay legible on the light day and dark night themes;
// animated bits (falling drops, flashing bolt, glowing sun) are CSS classes.
export function WeatherGlyph({ code, night = false, size = 24 }) {
  const kind = glyphKind(code)
  const s = { width: size, height: size }

  if (kind === 'clear') {
    if (night) {
      return (
        <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-moon" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" className="wx-glow" />
        </svg>
      )
    }
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-sun wx-glow" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2.4" /><path d="M12 19.6V22" /><path d="M2 12h2.4" /><path d="M19.6 12H22" />
        <path d="M4.9 4.9l1.7 1.7" /><path d="M17.4 17.4l1.7 1.7" /><path d="M19.1 4.9l-1.7 1.7" /><path d="M6.6 17.4l-1.7 1.7" />
      </svg>
    )
  }
  if (kind === 'partly') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="wx-drift">
        {night
          ? <path className="wxg-moon" d="M21 9.5A5 5 0 1 1 14.5 3 4 4 0 0 0 21 9.5z" strokeWidth="1.6" strokeLinejoin="round" />
          : <circle className="wxg-sun" cx="17" cy="7" r="3.6" strokeWidth="1.7" />}
        <path className="wxg-cloud-fill" d="M6 19a3.6 3.6 0 0 1 0-7.2 5 5 0 0 1 9.6-1.4A3.6 3.6 0 0 1 15 19z" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'cloudy' || kind === 'fog') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-cloud wx-drift" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={kind === 'fog' ? 'M7 13a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.5A4 4 0 0 1 17 13z' : 'M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.5A4 4 0 0 1 17 18z'} />
        {kind === 'fog' && <><path d="M5 17h14" opacity="0.7" /><path d="M7 20.5h10" opacity="0.45" /></>}
      </svg>
    )
  }
  if (kind === 'rain') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-rain" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="wxg-cloud" d="M7 14a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.5A4 4 0 0 1 17 14z" />
        <g className="wx-fall"><path d="M8 17v3" /><path d="M12 17v3" /><path d="M16 17v3" /></g>
      </svg>
    )
  }
  if (kind === 'storm') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path className="wxg-cloud" d="M7 13a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.5A4 4 0 0 1 17 13z" strokeWidth="1.8" strokeLinejoin="round" />
        <path className="wxg-bolt wx-flash" d="M13 13.5 L9.5 19 h2.6 l-1.8 4 5.2-6 h-2.7 l2-3.5 z" />
      </svg>
    )
  }
  if (kind === 'snow') {
    return (
      <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-snow" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="wxg-cloud" d="M7 13a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6-1.5A4 4 0 0 1 17 13z" />
        <g className="wx-fall-slow"><path d="M8 16.6l0 0.01" /><path d="M12 18.6l0 0.01" /><path d="M16 16.6l0 0.01" /><path d="M10 20.6l0 0.01" /><path d="M14 21.6l0 0.01" /></g>
      </svg>
    )
  }
  // ice / freezing rain: crystal
  return (
    <svg {...s} viewBox="0 0 24 24" fill="none" className="wxg-ice" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3v18" />
      <path d="M4.2 7.5l15.6 9" /><path d="M19.8 7.5l-15.6 9" />
      <path d="M12 3l-2.2 2.2M12 3l2.2 2.2" /><path d="M12 21l-2.2-2.2M12 21l2.2-2.2" />
    </svg>
  )
}
