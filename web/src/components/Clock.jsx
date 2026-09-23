import React, { useEffect, useState } from 'react'

export default function Clock({ onClick }) {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="clock" onClick={onClick} role={onClick ? 'button' : undefined} aria-label="Set a timer">
      <div className="clock-time">
        {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="clock-date">
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  )
}
