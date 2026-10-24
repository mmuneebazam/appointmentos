'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney } from '@/lib/money'

interface StaffRef {
  id: string
  name: string
  title: string | null
  color: string
}

interface ServiceRef {
  id: string
  name: string
  description: string | null
  durationMin: number
  priceCents: number
  depositCents: number
  isGroup: boolean
  maxParticipants: number
  staff: StaffRef[]
}

interface Slot {
  startsAt: string
  endsAt: string
  label: string
  endLabel: string
  staffId: string
  staffName: string
  remainingSeats: number
}

interface DaySummary {
  date: string
  openSlots: number
}

interface BookingResponse {
  appointment: { id: string; status: string; startsAt: string; endsAt: string; timezone: string }
  payment: { providerRef: string; clientSecret: string; amountCents: number } | null
  requiresPayment: boolean
  manageToken: string
  replayed: boolean
}

type Step = 'service' | 'time' | 'details' | 'payment' | 'done'

const STEP_LABEL: Record<Step, string> = {
  service: 'Choose',
  time: 'Time',
  details: 'Details',
  payment: 'Payment',
  done: 'Confirmed',
}

function isoDateInZone(zone: string, offsetDays = 0): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now.getTime() + offsetDays * 86_400_000))
  return parts
}

function prettyDay(iso: string, zone: string): { weekday: string; day: string; month: string } {
  const date = new Date(`${iso}T12:00:00Z`)
  return {
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: zone }).format(date),
    day: new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: zone }).format(date),
    month: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: zone }).format(date),
  }
}

export function BookingWizard({
  org,
  services,
}: {
  org: {
    slug: string
    name: string
    currency: string
    timezone: string
    brandColor: string
    depositRequired: boolean
    cancellationWindowHrs: number
    holdMinutes: number
  }
  services: ServiceRef[]
}) {
  const [step, setStep] = useState<Step>('service')
  const [service, setService] = useState<ServiceRef | null>(services[0] ?? null)
  const [staffId, setStaffId] = useState<string>('any')
  const [date, setDate] = useState<string>(isoDateInZone(org.timezone, 1))
  const [days, setDays] = useState<DaySummary[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [emptyReason, setEmptyReason] = useState<string | null>(null)
  const [selected, setSelected] = useState<Slot | null>(null)

  const [customer, setCustomer] = useState({ name: '', email: '', phone: '', notes: '' })
  const [hold, setHold] = useState<{ token: string; expiresAt: string } | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number>(0)
  const [idempotencyKey, setIdempotencyKey] = useState<string>('')

  const [booking, setBooking] = useState<BookingResponse | null>(null)
  const [paymentState, setPaymentState] = useState<
    | { kind: 'idle' }
    | { kind: 'processing' }
    | { kind: 'succeeded'; outcome: string }
    | { kind: 'failed'; message: string }
  >({ kind: 'idle' })
  const [lastEventId, setLastEventId] = useState<string | null>(null)
  const [replayNote, setReplayNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const pollRef = useRef<number | null>(null)

  const dates = useMemo(
    () => Array.from({ length: 14 }, (_, i) => isoDateInZone(org.timezone, i)),
    [org.timezone],
  )

  /* ── week strip: how many slots each day has ───────────────────── */
  const loadDays = useCallback(async () => {
    if (!service) return
    try {
      const res = await fetch(
        `/api/public/availability?org=${org.slug}&serviceId=${service.id}&date=${dates[0]}&mode=week&days=14`,
      )
      const json = await res.json()
      setDays(json.days ?? [])
    } catch {
      setDays([])
    }
  }, [org.slug, service, dates])

  useEffect(() => {
    void loadDays()
  }, [loadDays])

  /* ── day slots ─────────────────────────────────────────────────── */
  const loadSlots = useCallback(async () => {
    if (!service) return
    setSlotsLoading(true)
    setEmptyReason(null)
    try {
      const staffQuery = staffId !== 'any' ? `&staffId=${staffId}` : ''
      const res = await fetch(
        `/api/public/availability?org=${org.slug}&serviceId=${service.id}&date=${date}${staffQuery}`,
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'Could not load availability')
        setSlots([])
        return
      }
      const flat: Slot[] = (json.staff ?? []).flatMap((group: { slots: Slot[] }) => group.slots)
      flat.sort((a: Slot, b: Slot) => a.startsAt.localeCompare(b.startsAt))
      setSlots(flat)
      if (flat.length === 0) setEmptyReason(json.reasonIfEmpty ?? 'No times available on this date.')
    } catch {
      setError('Could not load availability')
    } finally {
      setSlotsLoading(false)
    }
  }, [date, org.slug, service, staffId])

  useEffect(() => {
    if (step === 'time') void loadSlots()
  }, [step, loadSlots])

  /* ── hold countdown ────────────────────────────────────────────── */
  useEffect(() => {
    if (step !== 'details' || !hold) return
    const tick = () => {
      const remaining = Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        setHold(null)
        setSelected(null)
        setStep('time')
        setError('Your hold expired and the slot was released. Please pick a time again.')
      }
    }
    tick()
    pollRef.current = window.setInterval(tick, 1000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [step, hold])

  async function chooseSlot(slot: Slot) {
    setError(null)
    setPending(true)
    try {
      const res = await fetch('/api/public/holds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug: org.slug,
          serviceId: service!.id,
          staffId: slot.staffId,
          startsAt: slot.startsAt,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'That time was just taken')
        void loadSlots()
        void loadDays()
        return
      }
      setSelected(slot)
      setHold({ token: json.token, expiresAt: json.expiresAt })
      setIdempotencyKey(crypto.randomUUID())
      setStep('details')
    } catch {
      setError('Network error while holding the slot')
    } finally {
      setPending(false)
    }
  }

  async function submitBooking(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || !service) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/public/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug: org.slug,
          serviceId: service.id,
          staffId: selected.staffId,
          startsAt: selected.startsAt,
          holdToken: hold?.token,
          idempotencyKey,
          notes: customer.notes || undefined,
          customer: {
            name: customer.name,
            email: customer.email,
            phone: customer.phone || undefined,
            timezone: org.timezone,
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'Could not complete the booking')
        if (json?.error?.code === 'conflict') {
          setStep('time')
          void loadSlots()
        }
        return
      }
      setBooking(json)
      setStep(json.requiresPayment ? 'payment' : 'done')
    } catch {
      setError('Network error — your slot is still held, try again')
    } finally {
      setPending(false)
    }
  }

  async function pay(outcome: 'succeed' | 'fail', reuseEventId?: string) {
    if (!booking?.payment) return
    setPaymentState({ kind: 'processing' })
    setReplayNote(null)
    try {
      const res = await fetch('/api/public/payments/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerRef: booking.payment.providerRef,
          outcome,
          eventId: reuseEventId,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setPaymentState({ kind: 'failed', message: json?.error?.message ?? 'Payment failed' })
        return
      }
      setLastEventId(json.eventId ?? null)
      if (outcome === 'succeed') {
        setPaymentState({
          kind: 'succeeded',
          outcome: json.outcome?.status ?? 'processed',
        })
        setStep('done')
      } else {
        setPaymentState({
          kind: 'failed',
          message: 'Card declined by the provider (simulated). The slot stays held until you pay or the hold expires.',
        })
      }
    } catch {
      setPaymentState({ kind: 'failed', message: 'Network error talking to the provider' })
    }
  }

  async function replayWebhook() {
    if (!lastEventId) return
    const res = await fetch('/api/public/payments/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerRef: booking!.payment!.providerRef,
        outcome: 'succeed',
        eventId: lastEventId,
      }),
    })
    const json = await res.json()
    setReplayNote(
      json?.outcome?.status === 'duplicate'
        ? 'Provider re-delivered the identical event. Nothing changed — no second charge, no second email.'
        : `Unexpected outcome: ${json?.outcome?.status ?? 'unknown'}`,
    )
  }

  const manageable = booking
    ? `/book/${org.slug}/appointment/${booking.manageToken}`
    : ''

  const stepIndex = ['service', 'time', 'details', 'payment', 'done'].indexOf(step)

  return (
    <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
      {/* ── main column ─────────────────────────────────────────── */}
      <div className="space-y-4">
        {/* progress */}
        <ol className="flex items-center gap-1.5 text-[11.5px]">
          {(['service', 'time', 'details', 'payment'] as Step[]).map((s, index) => {
            const active = step === s || (step === 'done' && s === 'payment')
            const doneSoFar = stepIndex > index || step === 'done'
            if (s === 'payment' && service && !org.depositRequired && service.depositCents === 0) return null
            return (
              <li key={s} className="flex items-center gap-1.5">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-semibold ${
                    doneSoFar
                      ? 'bg-emerald-500 text-white'
                      : active
                        ? 'bg-indigo-600 text-white'
                        : 'bg-[#e9ecf5] text-gray-500'
                  }`}
                >
                  {doneSoFar && !active ? '✓' : index + 1}
                </span>
                <span className={active ? 'font-semibold text-gray-900' : 'text-gray-500'}>{STEP_LABEL[s]}</span>
                {index < 3 ? <span className="mx-0.5 h-px w-4 bg-[var(--color-line)]" /> : null}
              </li>
            )
          })}
        </ol>

        {error ? (
          <p className="rounded-xl border border-[#fecdca] bg-[#fef3f2] px-3.5 py-2.5 text-[12.5px] text-[#b42318]">
            {error}
          </p>
        ) : null}

        {/* step: service */}
        {step === 'service' ? (
          <div className="card card-pad rise">
            <h2 className="text-[16px] font-semibold text-gray-900">What can we help with?</h2>
            <p className="mt-0.5 text-[12.5px] text-gray-500">
              Times shown in {org.timezone}. Deposits are {org.depositRequired ? 'required to confirm' : 'optional'}.
            </p>
            <div className="mt-3.5 space-y-2">
              {services.map((option) => {
                const active = service?.id === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setService(option)
                      setStaffId('any')
                    }}
                    className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
                      active
                        ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-200'
                        : 'border-[var(--color-line)] bg-white hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-semibold text-gray-900">
                          {option.name}
                          {option.isGroup ? (
                            <span className="ml-1.5 badge badge-blue">group · {option.maxParticipants} seats</span>
                          ) : null}
                        </p>
                        {option.description ? (
                          <p className="mt-0.5 text-[12px] text-gray-500">{option.description}</p>
                        ) : null}
                        <p className="mt-1 text-[11.5px] text-gray-500">
                          {option.durationMin} min · {option.staff.map((s) => s.name.split(' ')[0]).join(', ')}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="num text-[13.5px] font-semibold text-gray-900">
                          {formatMoney(option.priceCents, org.currency)}
                        </p>
                        {option.depositCents > 0 ? (
                          <p className="num text-[11px] text-gray-500">
                            {formatMoney(option.depositCents, org.currency)} deposit
                          </p>
                        ) : (
                          <p className="text-[11px] text-gray-500">no deposit</p>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            <h3 className="mt-5 text-[13px] font-semibold text-gray-900">Who would you like to see?</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setStaffId('any')}
                className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${
                  staffId === 'any'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                    : 'border-[var(--color-line)] bg-white text-gray-600'
                }`}
              >
                Anyone available
              </button>
              {(service?.staff ?? []).map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setStaffId(member.id)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] ${
                    staffId === member.id
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : 'border-[var(--color-line)] bg-white text-gray-600'
                  }`}
                >
                  <span className="dot" style={{ background: member.color }} />
                  {member.name}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              onClick={() => setStep('time')}
              disabled={!service}
            >
              See available times
            </button>
          </div>
        ) : null}

        {/* step: time */}
        {step === 'time' ? (
          <div className="card card-pad rise">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold text-gray-900">Pick a time</h2>
                <p className="mt-0.5 text-[12.5px] text-gray-500">
                  {service?.name} · {service?.durationMin} min
                </p>
              </div>
              <button type="button" onClick={() => setStep('service')} className="text-[12px] text-gray-500 hover:text-gray-800">
                Change
              </button>
            </div>

            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1 scroll-thin">
              {dates.map((iso) => {
                const summary = days.find((d) => d.date === iso)
                const info = prettyDay(iso, org.timezone)
                const active = iso === date
                const empty = summary?.openSlots === 0
                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => setDate(iso)}
                    className={`flex w-[52px] shrink-0 flex-col items-center rounded-lg border px-1.5 py-1.5 ${
                      active
                        ? 'border-indigo-500 bg-indigo-600 text-white'
                        : empty
                          ? 'border-[var(--color-line)] bg-[#fafbfd] text-gray-400'
                          : 'border-[var(--color-line)] bg-white text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-[10px] uppercase tracking-wide">{info.weekday}</span>
                    <span className="num text-[15px] font-semibold leading-tight">{info.day}</span>
                    <span className={`text-[9.5px] ${active ? 'text-indigo-100' : 'text-gray-400'}`}>
                      {summary ? `${summary.openSlots}` : '·'}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-4">
              {slotsLoading ? (
                <p className="text-[12.5px] text-gray-500">Checking availability…</p>
              ) : slots.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-line)] bg-[#fbfcfe] px-4 py-6 text-center">
                  <p className="text-[13px] font-medium text-gray-700">No times on this day</p>
                  <p className="mt-0.5 text-[12px] text-gray-500">{emptyReason}</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                  {slots.map((slot) => (
                    <button
                      key={`${slot.startsAt}-${slot.staffId}`}
                      type="button"
                      onClick={() => void chooseSlot(slot)}
                      disabled={pending}
                      className="rounded-lg border border-[var(--color-line)] bg-white px-2 py-2 text-center transition-colors hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-60"
                    >
                      <p className="num text-[13px] font-semibold text-gray-900">{slot.label}</p>
                      <p className="truncate text-[10px] text-gray-500">{slot.staffName.split(' ')[0]}</p>
                      {slot.remainingSeats > 1 ? (
                        <p className="text-[9.5px] text-indigo-600">{slot.remainingSeats} seats</p>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-3 text-[11px] leading-snug text-gray-500">
              Picking a time holds it for {org.holdMinutes} minutes while you finish checkout. Availability is
              re-checked on the server when you confirm.
            </p>
          </div>
        ) : null}

        {/* step: details */}
        {step === 'details' && selected ? (
          <form onSubmit={submitBooking} className="card card-pad rise">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold text-gray-900">Your details</h2>
                <p className="mt-0.5 text-[12.5px] text-gray-500">
                  We hold your slot for another{' '}
                  <span className="num font-semibold text-amber-700">
                    {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:
                    {String(secondsLeft % 60).padStart(2, '0')}
                  </span>
                </p>
              </div>
              <button type="button" onClick={() => setStep('time')} className="text-[12px] text-gray-500 hover:text-gray-800">
                Change time
              </button>
            </div>

            <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="name" className="label mb-1.5 block">
                  Full name
                </label>
                <input
                  id="name"
                  className="input"
                  required
                  minLength={2}
                  value={customer.name}
                  onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                  placeholder="Alex Morgan"
                />
              </div>
              <div>
                <label htmlFor="email" className="label mb-1.5 block">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="input"
                  required
                  value={customer.email}
                  onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
                  placeholder="alex@example.com"
                />
              </div>
              <div>
                <label htmlFor="phone" className="label mb-1.5 block">
                  Mobile (optional, for reminders)
                </label>
                <input
                  id="phone"
                  className="input"
                  value={customer.phone}
                  onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                  placeholder="+1 555 0100"
                />
              </div>
              <div>
                <label htmlFor="notes" className="label mb-1.5 block">
                  Anything we should know?
                </label>
                <input
                  id="notes"
                  className="input"
                  value={customer.notes}
                  onChange={(e) => setCustomer({ ...customer, notes: e.target.value })}
                  placeholder="First visit, lower-back pain"
                />
              </div>
            </div>

            <div className="mt-3 rounded-lg bg-[#fbfcfe] px-3 py-2 text-[11.5px] leading-snug text-gray-600">
              By booking you agree to the cancellation policy: free cancellation up to{' '}
              {org.cancellationWindowHrs} hours before the appointment.
            </div>

            <button type="submit" className="btn btn-primary mt-3.5 w-full" disabled={pending}>
              {pending ? 'Reserving…' : service && service.depositCents > 0 && org.depositRequired ? 'Continue to payment' : 'Confirm booking'}
            </button>
          </form>
        ) : null}

        {/* step: payment */}
        {step === 'payment' && booking ? (
          <div className="card card-pad rise">
            <h2 className="text-[16px] font-semibold text-gray-900">Take payment</h2>
            <p className="mt-0.5 text-[12.5px] text-gray-500">
              This demo uses a local provider that emits genuinely signed webhooks. The booking confirms when the
              webhook lands — not when this screen says so.
            </p>

            <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] p-3.5">
              <div className="flex items-center justify-between text-[12.5px] text-gray-600">
                <span>{service?.name}</span>
                <span className="num">{formatMoney(service?.priceCents ?? 0, org.currency)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[13px] font-semibold text-gray-900">
                <span>Deposit due now</span>
                <span className="num">
                  {formatMoney(booking.payment?.amountCents ?? 0, org.currency)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11.5px] text-gray-500">
                <span>Balance on the day</span>
                <span className="num">
                  {formatMoney((service?.priceCents ?? 0) - (booking.payment?.amountCents ?? 0), org.currency)}
                </span>
              </div>
              <p className="mt-2 truncate font-mono text-[10.5px] text-gray-400">
                {booking.payment?.providerRef}
              </p>
            </div>

            {paymentState.kind === 'failed' ? (
              <p className="mt-3 rounded-lg border border-[#fecdca] bg-[#fef3f2] px-3 py-2 text-[12px] text-[#b42318]">
                {paymentState.message}
              </p>
            ) : null}

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void pay('succeed')}
                disabled={paymentState.kind === 'processing'}
              >
                {paymentState.kind === 'processing' ? 'Contacting provider…' : 'Pay deposit (simulated card)'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void pay('fail')}
                disabled={paymentState.kind === 'processing'}
              >
                Simulate a declined card
              </button>
            </div>

            <p className="mt-3 text-[11px] leading-snug text-gray-500">
              Try the declined card: the payment is marked failed, the booking stays pending, and the hold is
              released automatically when it expires — no manual cleanup.
            </p>
          </div>
        ) : null}

        {/* step: done */}
        {step === 'done' && booking ? (
          <div className="card card-pad rise">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 10.5l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <h2 className="text-[16px] font-semibold text-gray-900">
                  {booking.requiresPayment ? 'Booked — pending payment' : 'You are booked'}
                </h2>
                <p className="text-[12.5px] text-gray-500">
                  Reference{' '}
                  <span className="font-mono text-[11.5px]">{booking.appointment.id.slice(0, 10)}</span> · status{' '}
                  <span className="font-medium">{booking.appointment.status.toLowerCase().replace('_', ' ')}</span>
                </p>
              </div>
            </div>

            <dl className="mt-3.5 grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
                <dt className="label">When</dt>
                <dd className="text-[12.5px] text-gray-800">
                  {new Intl.DateTimeFormat('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: org.timezone,
                  }).format(new Date(booking.appointment.startsAt))}
                </dd>
              </div>
              <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
                <dt className="label">Where</dt>
                <dd className="text-[12.5px] text-gray-800">{org.name}</dd>
              </div>
            </dl>

            {paymentState.kind === 'succeeded' ? (
              <div className="mt-3 rounded-xl border border-[#d1fadf] bg-[#ecfdf3] px-3 py-2.5">
                <p className="text-[12px] font-medium text-[#067647]">
                  Webhook processed ({paymentState.outcome}). Payment captured, booking confirmed and the
                  confirmation email queued exactly once.
                </p>
                <button
                  type="button"
                  onClick={() => void replayWebhook()}
                  className="mt-2 rounded-lg border border-[#a6f4c5] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#067647] hover:bg-[#f6fef9]"
                >
                  Re-deliver the same webhook
                </button>
                {replayNote ? <p className="mt-1.5 text-[11.5px] text-[#067647]">{replayNote}</p> : null}
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={manageable} className="btn btn-primary">
                Manage this booking
              </Link>
              <Link href={`/book/${org.slug}`} className="btn btn-secondary">
                Book another
              </Link>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-gray-500">
              The manage link is signed with an HMAC bound to this appointment and email, so it cannot be guessed or
              shared by changing an id.
            </p>
          </div>
        ) : null}
      </div>

      {/* ── summary rail ────────────────────────────────────────── */}
      <aside className="space-y-3">
        <div className="card card-pad">
          <p className="label">Your selection</p>
          {service ? (
            <div className="mt-2 space-y-2">
              <p className="text-[13.5px] font-semibold text-gray-900">{service.name}</p>
              <div className="space-y-1 text-[12px] text-gray-600">
                <p>
                  {service.durationMin} min · {formatMoney(service.priceCents, org.currency)}
                </p>
                <p>{org.name}</p>
                {selected ? (
                  <p className="num font-medium text-gray-900">
                    {prettyDay(date, org.timezone).weekday} {prettyDay(date, org.timezone).month}{' '}
                    {prettyDay(date, org.timezone).day} · {selected.label}
                  </p>
                ) : (
                  <p className="text-gray-400">No time selected</p>
                )}
                {selected ? <p className="text-gray-500">with {selected.staffName}</p> : null}
              </div>

              {org.depositRequired && service.depositCents > 0 ? (
                <div className="rounded-lg bg-[#fbfcfe] px-2.5 py-2 text-[11.5px] text-gray-600">
                  <p className="flex justify-between">
                    <span>Deposit due now</span>
                    <span className="num font-medium">{formatMoney(service.depositCents, org.currency)}</span>
                  </p>
                  <p className="mt-0.5 flex justify-between text-gray-500">
                    <span>Balance on the day</span>
                    <span className="num">{formatMoney(service.priceCents - service.depositCents, org.currency)}</span>
                  </p>
                </div>
              ) : (
                <p className="text-[11.5px] text-gray-500">No deposit required for this service.</p>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[12.5px] text-gray-500">Nothing selected yet.</p>
          )}
        </div>

        <div className="card card-pad">
          <p className="label">How this stays correct</p>
          <ul className="mt-2 space-y-2 text-[11.5px] leading-snug text-gray-600">
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
              The time you pick is held for {org.holdMinutes} minutes, then released automatically.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
              Two people cannot both confirm the same slot: the database rejects the second write.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
              Reminders are queued with a dedupe key, so a retried job never emails you twice.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
              Cancelling {org.cancellationWindowHrs}h ahead refunds the deposit automatically.
            </li>
          </ul>
        </div>
      </aside>
    </div>
  )
}
