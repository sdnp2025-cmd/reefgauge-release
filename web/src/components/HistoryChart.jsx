import React, { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDragScroll } from '../dragScroll.js'

// A history, on the dark ground the tank trends and ICP results already use.
//
// Bars rather than a line, because these are events: ten millilitres went in on
// Tuesday and nothing went in on Wednesday. A line between those two would draw
// a slope that never happened.

const W = 900
const H = 330
const PAD = { top: 26, right: 26, bottom: 48, left: 84 }

const dayLabel = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })

function niceMax(v) {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / mag) * mag
}

export default function HistoryChart({ title, subtitle, unit, points, target, ranges, range, onRange, action, onClose, children }) {
  const listRef = useRef(null)
  useDragScroll(listRef)

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const max = niceMax(Math.max(target ?? 0, ...points.map((p) => p.value), 0))
  const y = (v) => PAD.top + plotH - (v / max) * plotH

  // Bars share the width, with a gap that shrinks as the history grows.
  const slot = points.length ? plotW / points.length : plotW
  const barW = Math.max(3, Math.min(46, slot * 0.62))
  const x = (i) => PAD.left + slot * i + slot / 2

  const ticks = [0, max / 2, max]
  // A fortnight of daily bars cannot each carry a date without overprinting.
  const labelEvery = points.length <= 8 ? 1 : Math.ceil(points.length / 6)

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="trend-view" onClick={(e) => e.stopPropagation()}>
        <div className="month-header">
          <div className="trend-title">
            <span className="trend-name">{title}</span>
            {subtitle && <span className="trend-target">{subtitle}</span>}
          </div>
          <div className="month-nav">
            {action}
            <button className="month-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {ranges && (
          <div className="hist-ranges">
            {ranges.map((r) => (
              <button
                key={String(r.id)}
                className={`hist-range${r.id === range ? ' is-on' : ''}`}
                onClick={() => onRange(r.id)}
                aria-pressed={r.id === range}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {points.length === 0 ? (
          <div className="hist-empty">Nothing logged yet.</div>
        ) : (
          <svg className="trend-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} history`}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="icp-grid" />
                <text x={PAD.left - 14} y={y(t) + 7} className="icp-tick" textAnchor="end">
                  {Number.isInteger(t) ? t : t.toFixed(1)}
                </text>
              </g>
            ))}

            {target != null && (
              <>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(target)} y2={y(target)} className="hist-target" />
                <text x={PAD.left + plotW} y={y(target) - 10} className="hist-target-label" textAnchor="end">
                  usual {target} {unit}
                </text>
              </>
            )}

            {points.map((p, i) => (
              <rect
                key={p.ts}
                x={x(i) - barW / 2}
                y={y(p.value)}
                width={barW}
                height={Math.max(2, PAD.top + plotH - y(p.value))}
                rx={Math.min(6, barW / 3)}
                className={`hist-bar ${i === points.length - 1 ? 'last' : ''}`}
              />
            ))}

            {points.map((p, i) => (
              (i % labelEvery === 0 || i === points.length - 1) && (
                <text key={`l${p.ts}`} x={x(i)} y={H - 16} className="icp-xlabel" textAnchor="middle">
                  {dayLabel(p.ts)}
                </text>
              )
            ))}
          </svg>
        )}

        {children && <div className="hist-list" ref={listRef}>{children}</div>}
      </div>
    </div>,
    document.body
  )
}
