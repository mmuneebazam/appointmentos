'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function RunWorkerButton({ queueDepth }: { queueDepth: Record<string, number> }) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function run() {
    setState('running')
    setMessage(null)
    try {
      const res = await fetch('/api/dashboard/worker', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMessage(json?.error?.message ?? 'Worker run failed')
        setState('idle')
        return
      }
      setMessage(
        json.processed === 0
          ? 'Queue was empty — nothing due.'
          : `Processed ${json.processed} job${json.processed === 1 ? '' : 's'}.`,
      )
      setState('done')
      router.refresh()
    } catch {
      setMessage('Network error')
      setState('idle')
    }
  }

  const waiting = (queueDepth.QUEUED ?? 0) + (queueDepth.RUNNING ?? 0)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={run} className="btn btn-secondary !py-1.5 !text-[12.5px]" disabled={state === 'running'}>
        {state === 'running' ? 'Draining…' : `Drain queue (${waiting} due)`}
      </button>
      {message ? <span className="text-[11.5px] text-gray-500">{message}</span> : null}
    </div>
  )
}
