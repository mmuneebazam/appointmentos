import Link from 'next/link'
import { requirePageTenant } from '@/server/guard'
import {
  auditFeed,
  dashboardSummary,
  revenueByDay,
  staffWorkload,
  operationsSnapshot,
} from '@/server/queries'
import { Card, EmptyState, SectionHeader, Sparkline, Stat, StatusBadge, Avatar } from '@/components/ui'
import { formatMoney } from '@/lib/money'
import { formatTime, prettyDate, relativeLabel } from '@/lib/time'
import { describeAudit } from '@/server/audit'
import { RunWorkerButton } from './run-worker-button'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const ctx = await requirePageTenant()
  const zone = ctx.org.timezone
  const orgId = ctx.org.id

  const [summary, revenue, workload, audit, ops] = await Promise.all([
    dashboardSummary({ orgId, zone }),
    revenueByDay({ orgId, zone, days: 14 }),
    staffWorkload({ orgId, zone }),
    auditFeed({ orgId, take: 8 }),
    operationsSnapshot({ orgId }),
  ])

  const todayLabel = prettyDate(summary.today, zone)
  const queued = (summary.queueByStatus.QUEUED ?? 0) + (summary.queueByStatus.RUNNING ?? 0)
  const deadLettered =
    (summary.queueByStatus.DEAD_LETTER ?? 0) + summary.deadLetterNotifications

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">{todayLabel}</p>
          <h2 className="mt-0.5 text-[21px] font-semibold tracking-tight text-gray-900">
            Good to see you, {ctx.user.name.split(' ')[0]}
          </h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {summary.todayAppointments.length} appointment{summary.todayAppointments.length === 1 ? '' : 's'} on
            the books today · {summary.upcoming} confirmed in the next 7 days
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/calendar" className="btn btn-secondary">
            View calendar
          </Link>
          <Link href="/book/northside" className="btn btn-primary">
            Book a slot
          </Link>
        </div>
      </div>

      {/* stats */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Today"
          value={String(summary.todayAppointments.length)}
          sub={`${summary.pendingPayment} awaiting payment`}
          accent="brand"
        />
        <Stat
          label="Revenue · 30 days"
          value={formatMoney(summary.revenueCents, ctx.org.currency)}
          sub="captured payments"
          trend={summary.revenueTrend}
          accent="green"
        />
        <Stat
          label="Completed · 30 days"
          value={String(summary.completedLast30)}
          sub="sessions delivered"
          trend={summary.completedTrend}
          accent="brand"
        />
        <Stat
          label="Cancellation rate"
          value={`${summary.cancellationRate}%`}
          sub="of bookings created in 30 days"
          accent={summary.cancellationRate > 20 ? 'red' : 'amber'}
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
        {/* today's schedule */}
        <Card>
          <SectionHeader
            title="Today's schedule"
            hint={`Times shown in ${zone}`}
            action={
              <Link href="/dashboard/calendar" className="link text-[12.5px]">
                Full calendar
              </Link>
            }
          />
          <div className="mt-3.5 space-y-2">
            {summary.todayAppointments.length === 0 ? (
              <EmptyState
                title="Nothing scheduled today"
                hint="The team is free — a good moment to post the booking link."
              />
            ) : (
              summary.todayAppointments.map((appointment) => {
                const past = appointment.endsAt < new Date()
                return (
                  <div
                    key={appointment.id}
                    className={`flex items-center gap-3 rounded-xl border border-[var(--color-line)] px-3 py-2.5 ${
                      past ? 'bg-[#fbfcfd]' : 'bg-white'
                    }`}
                  >
                    <div className="w-[54px] shrink-0">
                      <p className="num text-[13px] font-semibold text-gray-900">
                        {formatTime(appointment.startsAt, zone)}
                      </p>
                      <p className="num text-[11px] text-gray-400">{formatTime(appointment.endsAt, zone)}</p>
                    </div>
                    <span
                      className="h-8 w-[3px] shrink-0 rounded-full"
                      style={{ background: appointment.staff.color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-gray-900">
                        {appointment.customer.name} · {appointment.service.name}
                      </p>
                      <p className="truncate text-[12px] text-gray-500">
                        with {appointment.staff.name}
                        {appointment.notes ? ` — ${appointment.notes}` : ''}
                      </p>
                    </div>
                    <div className="hidden shrink-0 text-right sm:block">
                      <p className="num text-[12.5px] font-medium text-gray-700">
                        {formatMoney(appointment.priceCents, appointment.currency)}
                      </p>
                      {appointment.amountPaidCents > 0 && appointment.amountPaidCents < appointment.priceCents ? (
                        <p className="num text-[11px] text-amber-600">
                          {formatMoney(appointment.amountPaidCents, appointment.currency)} paid
                        </p>
                      ) : null}
                    </div>
                    <StatusBadge status={appointment.status} />
                  </div>
                )
              })
            )}
          </div>
        </Card>

        <div className="space-y-4">
          {/* revenue */}
          <Card>
            <SectionHeader title="Captured revenue" hint="Last 14 days" />
            <div className="mt-2">
              <p className="num text-[22px] font-semibold text-gray-900">
                {formatMoney(
                  revenue.reduce((sum, d) => sum + d.cents, 0),
                  ctx.org.currency,
                )}
              </p>
              <Sparkline points={revenue.map((d) => d.cents)} />
              <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
                <span>{prettyDate(revenue[0]?.date ?? summary.today)}</span>
                <span>{prettyDate(revenue[revenue.length - 1]?.date ?? summary.today)}</span>
              </div>
            </div>
          </Card>

          {/* workload */}
          <Card>
            <SectionHeader title="Next 7 days" hint="Booked time vs configured availability" />
            <div className="mt-3 space-y-3">
              {workload.length === 0 ? (
                <EmptyState title="No active staff" />
              ) : (
                workload.map((member) => (
                  <div key={member.id}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar name={member.name} color={member.color} />
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] font-medium text-gray-900">{member.name}</p>
                          <p className="truncate text-[11px] text-gray-500">
                            {member.upcomingCount} upcoming · {Math.round(member.bookedMinutes / 60)}h booked
                          </p>
                        </div>
                      </div>
                      <span className="num text-[12px] font-semibold text-gray-700">{member.utilisation}%</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#eef0f6]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, member.utilisation)}%`,
                          background: member.color,
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1fr_1fr]">
        {/* activity */}
        <Card>
          <SectionHeader
            title="Activity"
            hint="Append-only audit trail — every state change is attributable"
          />
          <ul className="mt-3 space-y-2.5">
            {audit.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              audit.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[12.5px] leading-snug text-gray-800">{describeAudit(entry)}</p>
                    <p className="num text-[11px] text-gray-400">
                      {entry.action} · {relativeLabel(entry.createdAt)}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ul>
        </Card>

        {/* operations */}
        <Card>
          <SectionHeader
            title="Operational health"
            hint="Background work, holds and calendar state"
            action={
              <Link href="/dashboard/operations" className="link text-[12.5px]">
                Inspect
              </Link>
            }
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2.5">
              <p className="label">Queue</p>
              <p className="num mt-0.5 text-[17px] font-semibold text-gray-900">{queued}</p>
              <p className="text-[11.5px] text-gray-500">jobs waiting or running</p>
            </div>
            <div className="rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2.5">
              <p className="label">Needs attention</p>
              <p
                className="num mt-0.5 text-[17px] font-semibold"
                style={{ color: deadLettered > 0 ? '#b42318' : '#067647' }}
              >
                {deadLettered}
              </p>
              <p className="text-[11.5px] text-gray-500">dead-lettered jobs or messages</p>
            </div>
            <div className="rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2.5">
              <p className="label">Active holds</p>
              <p className="num mt-0.5 text-[17px] font-semibold text-gray-900">{ops.holds.length}</p>
              <p className="text-[11.5px] text-gray-500">
                {ops.holds[0]
                  ? `next expires ${relativeLabel(ops.holds[0].expiresAt)}`
                  : 'none right now'}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2.5">
              <p className="label">Calendars</p>
              <p className="num mt-0.5 text-[17px] font-semibold text-gray-900">{ops.accounts.length}</p>
              <p className="text-[11.5px] text-gray-500">
                {ops.mappings.filter((m) => m.state === 'FAILED').length} sync failure(s)
              </p>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-dashed border-[var(--color-line)] bg-white px-3 py-2.5">
            <p className="text-[12px] font-medium text-gray-800">Run the queue now</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-gray-500">
              In production <code className="font-mono text-[11px]">npm run worker</code> polls continuously. This
              button drains it once through the same code path.
            </p>
            <div className="mt-2">
              <RunWorkerButton queueDepth={summary.queueByStatus} />
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
