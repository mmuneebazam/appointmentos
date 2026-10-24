import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { verifyAppointmentToken } from '@/server/tokens'
import { evaluateCancellation } from '@/server/booking'
import { StatusBadge } from '@/components/ui'
import { ManageBooking } from './manage-client'

export const dynamic = 'force-dynamic'

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>
}) {
  const { slug, token } = await params
  const claims = verifyAppointmentToken(token)
  if (!claims) notFound()

  const appointment = await prisma.appointment.findUnique({
    where: { id: claims.appointmentId },
    include: { service: true, staff: true, customer: true, location: true, org: true, payments: true },
  })
  if (!appointment || appointment.org.slug !== slug) notFound()
  if (appointment.customer.email !== claims.email) notFound()

  const policy = evaluateCancellation({
    startsAt: appointment.startsAt,
    now: new Date(),
    windowHours: appointment.org.cancellationWindowHrs,
    amountPaidCents: appointment.amountPaidCents,
    priceCents: appointment.priceCents,
  })

  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: appointment.timezone,
  }).format(appointment.startsAt)

  return (
    <main className="min-h-screen bg-[var(--color-canvas)]">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <p className="text-[14px] font-semibold text-gray-900">{appointment.org.name}</p>
          <Link href="/" className="text-[12px] text-gray-500 hover:text-gray-800">
            Powered by AppointmentOS
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
        <div className="card card-pad">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="label">Your appointment</p>
              <h1 className="mt-0.5 text-[19px] font-semibold text-gray-900">{appointment.service.name}</h1>
              <p className="mt-0.5 text-[13px] text-gray-600">
                {when} · with {appointment.staff.name}
              </p>
              <p className="text-[12.5px] text-gray-500">
                {appointment.location.name} · {appointment.timezone}
              </p>
            </div>
            <StatusBadge status={appointment.status} />
          </div>

          <dl className="mt-3.5 grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
              <dt className="label">Price</dt>
              <dd className="num text-[13px] text-gray-800">
                {(appointment.priceCents / 100).toFixed(2)} {appointment.currency}
              </dd>
            </div>
            <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
              <dt className="label">Paid</dt>
              <dd className="num text-[13px] text-gray-800">
                {(appointment.amountPaidCents / 100).toFixed(2)} {appointment.currency}
              </dd>
            </div>
            <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
              <dt className="label">Balance</dt>
              <dd className="num text-[13px] text-gray-800">
                {((appointment.priceCents - appointment.amountPaidCents) / 100).toFixed(2)} {appointment.currency}
              </dd>
            </div>
          </dl>

          {appointment.status === 'CANCELLED' ? (
            <p className="mt-3 rounded-lg border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2 text-[12.5px] text-gray-600">
              This booking was cancelled
              {appointment.cancellationReason ? `: ${appointment.cancellationReason}` : '.'}
            </p>
          ) : null}
        </div>

        <ManageBooking
          token={token}
          orgSlug={slug}
          serviceId={appointment.serviceId}
          status={appointment.status}
          localDate={appointment.localDate}
          timezone={appointment.timezone}
          policy={{
            insideWindow: policy.insideWindow,
            windowHours: policy.windowHours,
            refundableCents: policy.refundableCents,
            feeCents: policy.feeCents,
          }}
          currency={appointment.currency}
        />

        <div className="card card-pad">
          <p className="label">Payment history</p>
          {appointment.payments.length === 0 ? (
            <p className="mt-1.5 text-[12.5px] text-gray-500">No payments recorded for this booking.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {appointment.payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                >
                  <span className="font-mono text-[11px] text-gray-600">{payment.providerRef}</span>
                  <span className="num text-[12px] text-gray-800">
                    {(payment.amountCents / 100).toFixed(2)} {payment.currency}
                  </span>
                  <StatusBadge status={payment.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-center text-[11.5px] text-gray-500">
          This page is protected by a signed link tied to your email. Need to change something else? Reply to your
          confirmation email.
        </p>
      </div>
    </main>
  )
}
