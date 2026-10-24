'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatMoney } from '@/lib/money'

interface Slot {
  startsAt: string
  label: string
  staffName: string
}

export function ManageBooking(props: {
  token: string
  orgSlug: string
  serviceId: string
  status: string
  localDate: string
  timezone: string
  currency: string
  policy: { insideWindow: boolean; windowHours: number; refundableCents: number; feeCents: number }
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'reschedule' | 'cancel'>('idle')
  const [date, setDate] = useState(props.localDate)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const closed = ['CANCELLED', 'COMPLETED'].includes(props.status)

  async function loadSlots(nextDate: string) {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/public/availability?org=${props.orgSlug}&serviceId=${props.serviceId}&date=${nextDate}`,
      )
      const json = await res.json()
      setSlots((json.staff ?? []).flatMap((group: { slots: Slot[] }) => group.slots))
    } catch {
      setError('Could not load availability')
    } finally {
      setLoading(false)
    }
  }

  async function act(body: Record<string, unknown>) {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch(`/api/public/manage/${props.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'That did not work')
        return
      }
      setMessage(
        body.action === 'cancel'
          ? `Cancelled. ${formatMoney(json.refundCents, props.currency)} will be refunded.`
          : 'Moved. Check your email for the new details.',
      )
      setMode('idle')
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setPending(false)
    }
  }

  if (closed) {
    return (
      <div className="card card-pad">
        <p className="text-[13px] font-medium text-gray-800">This booking is closed</p>
        <p className="mt-0.5 text-[12.5px] text-gray-500">
          Nothing to change here. You can book a new appointment any time.
        </p>
      </div>
    )
  }

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[13.5px] font-semibold text-gray-900">Need to change something?</p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Free cancellation up to {props.policy.windowHours} hours before your appointment.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setMode(mode === 'reschedule' ? 'idle' : 'reschedule')
              if (mode !== 'reschedule') void loadSlots(date)
            }}
            disabled={pending}
          >
            Reschedule
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setMode(mode === 'cancel' ? 'idle' : 'cancel')}
            disabled={pending}
          >
            Cancel
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg border border-[#fecdca] bg-[#fef3f2] px-3 py-1.5 text-[12px] text-[#b42318]">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 rounded-lg border border-[#d1fadf] bg-[#ecfdf3] px-3 py-1.5 text-[12px] text-[#067647]">
          {message}
        </p>
      ) : null}

      {mode === 'cancel' ? (
        <div className="mt-3 rounded-xl border border-[#fecdca] bg-[#fffbfb] p-3">
          <p className="text-[12.5px] text-gray-700">
            {props.policy.insideWindow
              ? `You are inside the ${props.policy.windowHours}-hour window, so ${formatMoney(props.policy.feeCents, props.currency)} is retained and ${formatMoney(props.policy.refundableCents, props.currency)} is refunded.`
              : `You are outside the window, so the full ${formatMoney(props.policy.refundableCents, props.currency)} is refunded.`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn btn-danger !py-1.5 !text-[12.5px]"
              onClick={() => void act({ action: 'cancel', reason: 'Cancelled by customer' })}
              disabled={pending}
            >
              {pending ? 'Cancelling…' : 'Yes, cancel it'}
            </button>
            <button type="button" className="btn btn-ghost !py-1.5 !text-[12.5px]" onClick={() => setMode('idle')}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'reschedule' ? (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-white p-3">
          <p className="text-[12.5px] font-medium text-gray-800">Pick a new time</p>
          <input
            type="date"
            className="input mt-2 !text-[12.5px]"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              void loadSlots(e.target.value)
            }}
          />
          {loading ? (
            <p className="mt-2 text-[12px] text-gray-500">Loading…</p>
          ) : slots && slots.length === 0 ? (
            <p className="mt-2 text-[12px] text-gray-500">No open times on that date.</p>
          ) : slots ? (
            <div className="mt-2 flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto scroll-thin">
              {slots.map((slot) => (
                <button
                  key={`${slot.startsAt}-${slot.staffName}`}
                  type="button"
                  className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-[11.5px] hover:border-indigo-300 hover:bg-indigo-50"
                  onClick={() => void act({ action: 'reschedule', startsAt: slot.startsAt })}
                  disabled={pending}
                >
                  {slot.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
