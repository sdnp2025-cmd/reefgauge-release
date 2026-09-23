import React from 'react'
import { api, usePolling } from '../api.js'

function dueText(days) {
  if (days < 0) return `${-days}d overdue`
  if (days === 0) return 'due today'
  return `in ${days}d`
}

export default function MaintList() {
  const [data, refetch] = usePolling('/api/maint', 5 * 60 * 1000)
  const tasks = data?.tasks ?? []
  if (!tasks.length) return null

  const done = async (task) => {
    await api(`/api/maint/${task.id}/done`, { method: 'POST' })
    refetch()
  }

  return (
    <div className="maint">
      <div className="maint-title">🔧 Maintenance</div>
      {tasks.map((t) => (
        <div key={t.id} className={`maint-row ${t.dueInDays < 0 ? 'overdue' : t.dueInDays <= 0 ? 'due' : ''}`}>
          <span className="maint-name">{t.name}</span>
          <span className="maint-due">{dueText(t.dueInDays)}</span>
          <button className="maint-done" onClick={() => done(t)} aria-label={`Mark ${t.name} done`}>✓</button>
        </div>
      ))}
    </div>
  )
}
