import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePageTenant } from '@/server/guard'
import { appointmentDetail } from '@/server/queries'
import { prisma } from '@/lib/db'
import { Card, KeyValue, StatusBadge } from '@/components/ui'
import { formatMoney } from '@/lib/money'
import { formatDateTime, relativeLabel } from '@/lib/time'
import { evaluateCancellation } from '@/server/booking'
import { AppointmentActions } from './actions'

export const dynamic = 'force-dynamic'

export default async function AppointmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageTenant()
  const { id } = await params
  const appointment = await appointmentDetail(ctx.org.id, id)
  if (!appointment) notFound()

  const zone = appointment.timezone
  const policy = evaluateCancellation({
    startsAt: appointment.startsAt,
    now: new Date(),
    windowHours: ctx.org.cancellationWindowHrs,
    amountPaidCents: appointment.amountPaidCents,
    priceCents: appointment.priceCents,
  })

  const audit = await prisma.auditLog.findMany({
    where: { orgId: ctx.org.id, entityId: appointment.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/dashboard/appointments" className="text-[12.5px] text-gray-500 hover:text-gray-800">
            ← All appointments
          </Link>
          <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-gray-900">
            {appointment.service.name} · {appointment.customer.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-2 text-[13px] text-gray-500">
            {formatDateTime(appointment.startsAt, zone)} · {appointment.staff.name}
            <StatusBadge status={appointment.status} />
            {appointment.startsAt > new Date() ? (
              <span className="text-[11.5px] text-gray-400">{relativeLabel(appointment.startsAt)}</span>
            ) : null}
          </p>
        </div>
        <AppointmentActions
          appointmentId={appointment.id}
          status={appointment.status}
          priceCents={appointment.priceCents}
          amountPaidCents={appointment.amountPaidCents}
          refundableCents={policy.refundableCents}
          feeCents={policy.feeCents}
          insideWindow={policy.insideWindow}
          serviceId={appointment.serviceId}
          orgSlug={ctx.org.slug}
          zone={zone}
          localDate={appointment.localDate}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Booking detail</h3>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <KeyValue label="When" value={formatDateTime(appointment.startsAt, zone)} />
              <KeyValue label="Ends" value={formatDateTime(appointment.endsAt, zone)} />
              <KeyValue label="Duration" value={`${appointment.service.durationMin} min`} />
              <KeyValue label="Location" value={appointment.location.name} />
              <KeyValue label="Time zone" value={`${zone} (${appointment.localDate})`} />
              <KeyValue
                label="Buffers"
                value={`${appointment.service.bufferBeforeMin}m before · ${appointment.service.bufferAfterMin}m after`}
              />
              <KeyValue
                label="Occupied block"
                value={`${formatDateTime(appointment.blockStartsAt, zone)} → ${formatDateTime(appointment.blockEndsAt, zone)}`}
              />
              <KeyValue label="Seats" value={String(appointment.seats)} />
            </div>
            {appointment.notes ? (
              <p className="mt-3 rounded-lg bg-[#fbfcfe] px-3 py-2 text-[12.5px] text-gray-700">
                <span className="label block">Customer notes</span>
                {appointment.notes}
              </p>
            ) : null}
            {appointment.cancellationReason ? (
              <p className="mt-3 rounded-lg border border-[#fecdca] bg-[#fef3f2] px-3 py-2 text-[12.5px] text-[#b42318]">
                Cancelled: {appointment.cancellationReason}
              </p>
            ) : null}
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Money</h3>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <KeyValue label="Price" value={formatMoney(appointment.priceCents, appointment.currency)} />
              <KeyValue label="Paid" value={formatMoney(appointment.amountPaidCents, appointment.currency)} />
              <KeyValue
                label="Outstanding"
                value={formatMoney(
                  Math.max(0, appointment.priceCents - appointment.amountPaidCents),
                  appointment.currency,
                )}
              />
            </div>
            <div className="mt-3 space-y-1.5">
              {appointment.payments.length === 0 ? (
                <p className="text-[12.5px] text-gray-500">No payment record — this booking needed no deposit.</p>
              ) : (
                appointment.payments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-[11.5px] text-gray-700">{payment.providerRef}</p>
                      <p className="text-[11px] text-gray-500">
                        {payment.provider} · {payment.idempotencyKey}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="num text-[12.5px] text-gray-800">
                        {formatMoney(payment.amountCents, payment.currency)}
                      </span>
                      <StatusBadge status={payment.status} />
                    </div>
                    {payment.refunds.length > 0 ? (
                      <p className="w-full text-[11px] text-violet-700">
                        {payment.refunds.length} refund(s) ·{' '}
                        {formatMoney(
                          payment.refunds.reduce((sum, r) => sum + r.amountCents, 0),
                          payment.currency,
                        )}{' '}
                        ({payment.refunds[payment.refunds.length - 1].status.toLowerCase()})
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            <p className="mt-2 text-[11.5px] text-gray-500">
              Cancelling now:{' '}
              {policy.insideWindow ? (
                <span className="font-medium text-amber-700">
                  inside the {policy.windowHours}h window — {formatMoney(policy.feeCents, appointment.currency)} fee
                  retained, {formatMoney(policy.refundableCents, appointment.currency)} refunded
                </span>
              ) : (
                <span className="font-medium text-emerald-700">
                  outside the window — full {formatMoney(policy.refundableCents, appointment.currency)} refundable
                </span>
              )}
            </p>
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Audit trail</h3>
            <ul className="mt-2.5 space-y-2">
              {audit.length === 0 ? (
                <li className="text-[12.5px] text-gray-500">No audit entries.</li>
              ) : (
                audit.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                    <div>
                      <p className="text-[12.5px] text-gray-800">{entry.action}</p>
                      <p className="font-mono text-[11px] text-gray-400">
                        {entry.actorType} · {formatDateTime(entry.createdAt, zone)}
                      </p>
                      <p className="text-[11px] text-gray-500">{entry.metadata}</p>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Customer</h3>
            <div className="mt-2 space-y-2">
              <KeyValue label="Name" value={appointment.customer.name} />
              <KeyValue label="Email" value={appointment.customer.email} />
              <KeyValue label="Phone" value={appointment.customer.phone ?? '—'} />
              <KeyValue label="Customer since" value={formatDateTime(appointment.customer.createdAt, zone)} />
            </div>
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Notifications</h3>
            <ul className="mt-2 space-y-2">
              {appointment.notifications.length === 0 ? (
                <li className="text-[12.5px] text-gray-500">Nothing queued.</li>
              ) : (
                appointment.notifications.map((notification) => (
                  <li
                    key={notification.id}
                    className="rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-gray-800">
                        {notification.template.replace(/_/g, ' ').toLowerCase()} · {notification.channel.toLowerCase()}
                      </span>
                      <StatusBadge status={notification.status} />
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-gray-500">{notification.recipient}</p>
                    <p className="mt-0.5 font-mono text-[10.5px] text-gray-400">
                      dedupe: {notification.dedupeKey}
                    </p>
                    {notification.lastError ? (
                      <p className="mt-0.5 text-[11px] text-[#b42318]">{notification.lastError}</p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
            <p className="mt-2 text-[11px] leading-snug text-gray-500">
              The dedupe key makes each message sendable exactly once, even if the job is retried.
            </p>
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-gray-900">Calendar sync</h3>
            {appointment.calendarEvents.length === 0 ? (
              <p className="mt-1.5 text-[12.5px] text-gray-500">
                No external calendar connected for this organisation.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {appointment.calendarEvents.map((mapping) => (
                  <li
                    key={mapping.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                  >
                    <div>
                      <p className="text-[12px] font-medium text-gray-800">
                        {mapping.provider.replace('_', ' ').toLowerCase()}
                      </p>
                      <p className="font-mono text-[10.5px] text-gray-500">{mapping.externalEventId}</p>
                    </div>
                    <StatusBadge status={mapping.state} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-gray-500">
              Event ids are deterministic per appointment and provider, so a retried sync updates the event instead
              of creating a second one.
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}
