import React from 'react'

// The sky behind the weather card. Inline SVG, never emoji, and animated with
// transforms and opacity only — the Pi's compositor handles those without
// touching the CPU, while an animated filter or box-shadow on a 7" panel
// stutters visibly.
//
// Everything here is deliberately slow. The reef card taught the lesson: a
// wall display is looked at from across a room for two seconds at a time, so
// motion should be the kind you notice only if you stay. Nothing in here
// changes the card's brightness by more than a few percent.
//
// Drawn into a 300x200 box that fills the card. The left half stays quiet
// because the temperature sits there.

const Sky = ({ children, className = '' }) => (
  <div className={`wx-scene ${className}`} aria-hidden="true">
    <svg viewBox="0 0 300 200" preserveAspectRatio="xMidYMid slice">{children}</svg>
  </div>
)

// One cloud, drawn from overlapping circles — a path would be no more
// convincing at this size and far harder to nudge.
const Cloud = ({ x, y, s = 1, fill = 'rgba(255,255,255,0.78)' }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`} fill={fill}>
    <ellipse cx="0" cy="10" rx="34" ry="13" />
    <circle cx="-12" cy="4" r="13" />
    <circle cx="6" cy="0" r="17" />
    <circle cx="24" cy="6" r="12" />
  </g>
)

const Sun = ({ x, y, r = 26, hot }) => (
  <g transform={`translate(${x} ${y})`}>
    <circle cx="0" cy="0" r={r * 1.9} fill={hot ? 'rgba(255,180,120,0.30)' : 'rgba(255,224,150,0.34)'} />
    <g className="wx-rays" stroke={hot ? 'rgba(233,120,55,0.85)' : 'rgba(240,168,44,0.85)'} strokeWidth="4.6" strokeLinecap="round" fill="none">
      {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a) => {
        const rad = (a * Math.PI) / 180
        const inner = r + 9
        const outer = r + (a % 60 === 0 ? 30 : 20)
        return (
          <path
            key={a}
            d={`M${Math.cos(rad) * inner} ${Math.sin(rad) * inner} L${Math.cos(rad) * outer} ${Math.sin(rad) * outer}`}
          />
        )
      })}
    </g>
    <circle cx="0" cy="0" r={r} fill={hot ? '#f9963c' : '#fbc53a'} />
  </g>
)

const Moon = ({ x, y }) => (
  <g transform={`translate(${x} ${y})`}>
    <circle cx="0" cy="0" r="46" fill="rgba(226,232,255,0.22)" />
    <path d="M6-24a24 24 0 1 0 12 40A28 28 0 0 1 6-24Z" fill="#eef1ff" />
  </g>
)

// Fixed rather than random: a layout that reshuffles on every render is a
// layout nobody can judge, and the eye reads honest irregularity the same way
// either side of a reload.
const STARS = [
  [28, 26, 1.6, 0], [62, 46, 1.1, 1.4], [96, 18, 1.9, 2.8], [128, 52, 1.2, 0.7],
  [168, 24, 1.5, 2.1], [206, 58, 1.1, 3.4], [242, 30, 1.8, 1.1], [274, 62, 1.3, 2.4],
  [46, 74, 1.2, 3.1], [148, 86, 1.4, 1.8], [286, 100, 1.1, 0.4], [12, 104, 1.5, 2.6]
]

const RAIN = [
  [24, 0], [48, 1.1], [70, 0.4], [96, 1.5], [118, 0.8], [142, 0.2], [166, 1.3],
  [190, 0.6], [212, 1.7], [236, 0.9], [258, 1.9], [282, 0.5], [10, 1.2], [130, 1.9]
]

const FLAKES = [
  [22, 0, 3.4], [52, 1.8, 2.6], [80, 0.6, 3.9], [110, 2.6, 2.9], [138, 1.2, 3.5],
  [168, 3.2, 2.7], [196, 0.3, 3.8], [224, 2.1, 3.1], [252, 1.5, 3.6], [280, 3.6, 2.8],
  [66, 4.2, 3.0], [186, 4.8, 3.4]
]

export default function WeatherScene({ mood }) {
  switch (mood) {
    case 'sunny':
    case 'hot':
      return (
        <Sky className={mood === 'hot' ? 'wx-scene-hot' : ''}>
          <Sun x={236} y={56} hot={mood === 'hot'} />
          <g className="wx-drift-slow"><Cloud x={40} y={132} s={0.85} fill="rgba(255,255,255,0.6)" /></g>
          <g className="wx-drift-fast"><Cloud x={196} y={150} s={0.6} fill="rgba(255,255,255,0.5)" /></g>
        </Sky>
      )

    case 'clearnight':
      return (
        <Sky>
          {STARS.map(([x, y, r, d], i) => (
            <circle key={i} className="wx-star" cx={x} cy={y} r={r} fill="#f4f6ff" style={{ animationDelay: `${d}s` }} />
          ))}
          <Moon x={240} y={56} />
          <g className="wx-drift-slow"><Cloud x={64} y={148} s={0.7} fill="rgba(226,232,255,0.30)" /></g>
        </Sky>
      )

    case 'cloudy':
      return (
        <Sky>
          <g className="wx-drift-slow"><Cloud x={210} y={44} s={1.15} /></g>
          <g className="wx-drift-mid"><Cloud x={104} y={78} s={0.9} fill="rgba(255,255,255,0.6)" /></g>
          <g className="wx-drift-fast"><Cloud x={252} y={138} s={0.7} fill="rgba(255,255,255,0.45)" /></g>
        </Sky>
      )

    case 'fog':
      return (
        <Sky>
          <g className="wx-drift-slow"><Cloud x={216} y={40} s={1} fill="rgba(255,255,255,0.5)" /></g>
          {[62, 92, 122, 152, 178].map((y, i) => (
            <rect
              key={y}
              className={i % 2 ? 'wx-fog-b' : 'wx-fog-a'}
              x="-60" y={y} width="420" height="11" rx="5.5"
              fill="rgba(255,255,255,0.42)"
              style={{ animationDelay: `${i * -3.5}s` }}
            />
          ))}
        </Sky>
      )

    case 'rain':
    case 'storm':
      return (
        <Sky>
          <g className="wx-drift-slow"><Cloud x={214} y={38} s={1.2} fill="rgba(238,244,252,0.85)" /></g>
          <g className="wx-drift-mid"><Cloud x={92} y={58} s={0.85} fill="rgba(226,236,248,0.65)" /></g>
          {mood === 'storm' && (
            <path className="wx-bolt" d="M232 74l-16 30h13l-8 26 26-34h-14l10-22z" fill="#ffe066" />
          )}
          {RAIN.map(([x, d], i) => (
            <line
              key={i}
              className="wx-drop"
              x1={x} y1="-16" x2={x - 6} y2="6"
              stroke="rgba(78,142,204,0.8)" strokeWidth="2.8" strokeLinecap="round"
              style={{ animationDelay: `${d}s`, animationDuration: `${1.5 + (i % 4) * 0.28}s` }}
            />
          ))}
        </Sky>
      )

    case 'snow':
    case 'cold':
      return (
        <Sky>
          <g className="wx-drift-slow"><Cloud x={216} y={40} s={1.1} fill="rgba(246,250,255,0.85)" /></g>
          {FLAKES.map(([x, d, r], i) => (
            <circle
              key={i}
              className="wx-flake"
              cx={x} cy="-10" r={r}
              fill="#ffffff" stroke="rgba(126,170,209,0.75)" strokeWidth="0.9"
              style={{ animationDelay: `${d}s`, animationDuration: `${8 + (i % 5) * 1.6}s` }}
            />
          ))}
        </Sky>
      )

    default:
      return null
  }
}
