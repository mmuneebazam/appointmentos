'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function OpsControls({
  queueDepth,
  connected,
  transport,
}: {
  queueDepth: Record<string, number>
  connected: [boolean, boolean]
  transport: { email: string; sms: string; payments: string; calendar: string }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function drain() {
    setBusy('drain')
    setMessage(null)
    try {
      const res = await fetch('/api/dashboard/worker', { method: 'POST' })
      const json = await res.json()
      setMessage(
        res.ok
          ? json.processed === 0
            ? 'Nothing was due.'
            : `Processed ${json.processed} job(s).`
          : (json?.error?.message ?? 'Failed'),
      )
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function toggleCalendar(provider: 'GOOGLE_CALENDAR' | 'MICROSOFT_GRAPH', isConnected: boolean) {
    setBusy(provider)
    setMessage(null)
    try {
      const res = await fetch('/api/dashboard/integrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: isConnected ? 'disconnect' : 'connect', provider }),
      })
      const json = await res.json()
      setMessage(res.ok ? `${isConnected ? 'Disconnected' : 'Connected'} ${provider}.` : (json?.error?.message ?? 'Failed'))
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const due = (queueDepth.QUEUED ?? 0) + (queueDepth.RUNNING ?? 0)

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[13.5px] font-semibold text-gray-900">Controls</p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Queue: {Object.entries(queueDepth).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') || 'empty'} ·
            transports: {transport.email} / {transport.sms} / {transport.payments}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={drain} className="btn btn-secondary" disabled={busy !== null}>
            {busy === 'drain' ? 'Draining…' : `Drain queue (${due})`}
          </button>
          <button
            type="button"
            onClick={() => toggleCalendar('GOOGLE_CALENDAR', connected[0])}
            className="btn btn-secondary"
            disabled={busy !== null}
          >
            {connected[0] ? 'Disconnect Google' : 'Connect Google'}
          </button>
          <button
            type="button"
            onClick={() => toggleCalendar('MICROSOFT_GRAPH', connected[1])}
            className="btn btn-secondary"
            disabled={busy !== null}
          >
            {connected[1] ? 'Disconnect Outlook' : 'Connect Outlook'}
          </button>
        </div>
      </div>
      {message ? <p className="mt-2 text-[12px] text-gray-600">{message}</p> : null}
    </div>
  )
}
