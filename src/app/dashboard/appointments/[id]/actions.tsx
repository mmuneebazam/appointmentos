'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatMoney } from '@/lib/money'

interface Slot {
  startsAt: string
  label: string
  staffName: string
}

interface AvailabilityResponse {
  staff: Array<{ staffId: string; staffName: string; slots: Slot[] }>
}

export function AppointmentActions(props: {
  appointmentId: string
  status: string
  priceCents: number
  amountPaidCents: number
  refundableCents: number
  feeCents: number
  insideWindow: boolean
  serviceId: string
  orgSlug: string
  zone: string
  localDate: string
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'cancel' | 'reschedule'>('idle')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [date, setDate] = useState(props.localDate)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [loadingSlots, setLoadingSlots] = useState(false)

  const terminal = ['CANCELLED', 'COMPLETED'].includes(props.status)

  async function call(path: string, body?: unknown) {
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'That did not work')
        return null
      }
      return json
    } catch {
      setError('Network error')
      return null
    } finally {
      setPending(false)
    }
  }

  async function loadSlots(nextDate: string) {
    setLoadingSlots(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/public/availability?org=${props.orgSlug}&serviceId=${props.serviceId}&date=${nextDate}`,
      )
      const json = (await res.json()) as AvailabilityResponse
      setSlots(json.staff.flatMap((s) => s.slots))
    } catch {
      setError('Could not load availability')
    } finally {
      setLoadingSlots(false)
    }
  }

  async function onComplete() {
    const result = await call(`/api/dashboard/appointments/${props.appointmentId}/complete`)
    if (result) {
      setNotice('Marked complete.')
      router.refresh()
    }
  }

  async function onCancel() {
    const result = await call(`/api/dashboard/appointments/${props.appointmentId}/cancel`, { reason })
    if (result) {
      setNotice(
        result.alreadyCancelled
          ? 'Already cancelled.'
          : `Cancelled. Refunded ${formatMoney(result.refundCents)} · fee kept ${formatMoney(result.feeCents)}.`,
      )
      setMode('idle')
      router.refresh()
    }
  }

  async function onReschedule(startsAt: string) {
    const result = await call(`/api/dashboard/appointments/${props.appointmentId}/reschedule`, {
      startsAt,
      reason: reason || 'Rescheduled by staff',
    })
    if (result) {
      setNotice('Moved. The old slot was released and the customer was notified.')
      setMode('idle')
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!terminal ? (
          <>
            <button type="button" onClick={onComplete} className="btn btn-secondary" disabled={pending}>
              Mark complete
            </button>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'reschedule' ? 'idle' : 'reschedule')
                if (mode !== 'reschedule') void loadSlots(date)
              }}
              className="btn btn-secondary"
              disabled={pending}
            >
              Reschedule
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === 'cancel' ? 'idle' : 'cancel')}
              className="btn btn-danger"
              disabled={pending}
            >
              Cancel
            </button>
          </>
        ) : (
          <span className="badge badge-neutral">{props.status.toLowerCase()}</span>
        )}
      </div>

      {error ? (
        <p className="max-w-[420px] rounded-lg border border-[#fecdca] bg-[#fef3f2] px-3 py-1.5 text-[12px] text-[#b42318]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="max-w-[420px] rounded-lg border border-[#d1fadf] bg-[#ecfdf3] px-3 py-1.5 text-[12px] text-[#067647]">
          {notice}
        </p>
      ) : null}

      {mode === 'cancel' ? (
        <div className="w-full max-w-[420px] rounded-xl border border-[#fecdca] bg-[#fffbfb] p-3">
          <p className="text-[12.5px] font-semibold text-[#b42318]">Cancel this appointment?</p>
          <p className="mt-1 text-[11.5px] leading-snug text-gray-600">
            {props.insideWindow
              ? `Inside the cancellation window: ${formatMoney(props.feeCents)} is retained as a fee and ${formatMoney(props.refundableCents)} is refunded.`
              : `Outside the window: the full ${formatMoney(props.refundableCents)} paid is refunded.`}{' '}
            The slot is released immediately.
          </p>
          <input
            className="input mt-2 !text-[12.5px]"
            placeholder="Reason (shown in the audit log)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={onCancel} className="btn btn-danger !py-1.5 !text-[12.5px]" disabled={pending}>
              {pending ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button type="button" onClick={() => setMode('idle')} className="btn btn-ghost !py-1.5 !text-[12.5px]">
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'reschedule' ? (
        <div className="w-full max-w-[460px] rounded-xl border border-[var(--color-line)] bg-white p-3 shadow-sm">
          <p className="text-[12.5px] font-semibold text-gray-900">Move to a new time</p>
          <p className="mt-0.5 text-[11.5px] text-gray-500">
            The new slot is reserved before the old one is released, so a failed move leaves the booking intact.
          </p>
          <input
            type="date"
            className="input mt-2 !text-[12.5px]"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              void loadSlots(e.target.value)
            }}
          />
          {loadingSlots ? (
            <p className="mt-2 text-[12px] text-gray-500">Loading availability…</p>
          ) : slots && slots.length === 0 ? (
            <p className="mt-2 text-[12px] text-gray-500">No open slots on that date.</p>
          ) : slots ? (
            <div className="mt-2 flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto scroll-thin">
              {slots.map((slot) => (
                <button
                  key={`${slot.startsAt}-${slot.staffName}`}
                  type="button"
                  onClick={() => onReschedule(slot.startsAt)}
                  className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-[11.5px] text-gray-700 hover:border-indigo-300 hover:bg-indigo-50"
                  disabled={pending}
                >
                  {slot.label} · {slot.staffName.split(' ')[0]}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" onClick={() => setMode('idle')} className="btn btn-ghost mt-2 !py-1 !text-[11.5px]">
            Close
          </button>
        </div>
      ) : null}
    </div>
  )
}
