import Link from 'next/link'
import { requirePageTenant } from '@/server/guard'
import { calendarBookings } from '@/server/queries'
import { prisma } from '@/lib/db'
import { Card, StatusBadge, EmptyState } from '@/components/ui'
import { formatMoney } from '@/lib/money'
import { DateTime, addLocalDays, localMinutesOf } from '@/lib/time'

export const dynamic = 'force-dynamic'

const HOUR_START = 8
const HOUR_END = 20
const HOUR_HEIGHT = 54

interface Block {
  id: string
  top: number
  height: number
  lane: number
  lanes: number
  label: string
  time: string
  staff: string
  color: string
  status: string
  price: number
  currency: string
  customer: string
  service: string
}

/** Greedy lane assignment so overlapping appointments sit side by side. */
function layoutDay(appointments: Array<{ startsAt: Date; endsAt: Date }>): { lane: number; lanes: number }[] {
  const order = appointments
    .map((a, i) => ({ i, start: a.startsAt.getTime(), end: a.endsAt.getTime() }))
    .sort((x, y) => x.start - y.start)
  const lanes: number[][] = []
  const assignment = new Array<number>(appointments.length).fill(0)

  for (const item of order) {
    let placed = false
    for (let lane = 0; lane < lanes.length; lane++) {
      if (lanes[lane].every((otherIndex) => {
        const other = appointments[otherIndex]
        return item.start >= other.endsAt.getTime() || item.end <= other.startsAt.getTime()
      })) {
        lanes[lane].push(item.i)
        assignment[item.i] = lane
        placed = true
        break
      }
    }
    if (!placed) {
      lanes.push([item.i])
      assignment[item.i] = lanes.length - 1
    }
  }
  return assignment.map((lane) => ({ lane, lanes: Math.max(1, lanes.length) }))
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; staff?: string }>
}) {
  const ctx = await requirePageTenant()
  const zone = ctx.org.timezone
  const params = await searchParams
  const weekOffset = Number(params.week ?? 0) || 0
  const staffFilter = params.staff && params.staff !== 'all' ? params.staff : undefined

  const today = DateTime.now().setZone(zone).toISODate()!
  // ISO week: Monday is day 0 of the grid. Luxon weekday is 1..7 with Monday=1.
  const weekdayIndex = DateTime.now().setZone(zone).weekday - 1
  const startDate = addLocalDays(today, weekOffset * 7 - weekdayIndex)

  const [{ dates, appointments }, staff] = await Promise.all([
    calendarBookings({ orgId: ctx.org.id, fromDate: startDate, days: 7, zone, staffId: staffFilter }),
    prisma.staff.findMany({
      where: { orgId: ctx.org.id, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true },
    }),
  ])

  const byDate = new Map<string, typeof appointments>()
  for (const date of dates) byDate.set(date, [])
  for (const appointment of appointments) {
    const list = byDate.get(appointment.localDate)
    if (list) list.push(appointment)
  }

  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
  const totalRevenue = appointments
    .filter((a) => ['CONFIRMED', 'COMPLETED'].includes(a.status))
    .reduce((sum, a) => sum + a.priceCents, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">Week view</p>
          <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-gray-900">
            {DateTime.fromISO(dates[0], { zone }).toFormat('LLL d')} –{' '}
            {DateTime.fromISO(dates[6], { zone }).toFormat('LLL d, yyyy')}
          </h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {appointments.length} appointment{appointments.length === 1 ? '' : 's'} ·{' '}
            {formatMoney(totalRevenue, ctx.org.currency)} booked value
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-[var(--color-line)] bg-white">
            <Link
              href={`/dashboard/calendar?week=${weekOffset - 1}${staffFilter ? `&staff=${staffFilter}` : ''}`}
              className="px-2.5 py-1.5 text-[12.5px] text-gray-600 hover:bg-gray-50"
            >
              ← Prev
            </Link>
            <Link href="/dashboard/calendar" className="border-x border-[var(--color-line)] px-2.5 py-1.5 text-[12.5px] text-gray-700 hover:bg-gray-50">
              This week
            </Link>
            <Link
              href={`/dashboard/calendar?week=${weekOffset + 1}${staffFilter ? `&staff=${staffFilter}` : ''}`}
              className="px-2.5 py-1.5 text-[12.5px] text-gray-600 hover:bg-gray-50"
            >
              Next →
            </Link>
          </div>

          <div className="flex flex-wrap gap-1">
            <Link
              href={`/dashboard/calendar?week=${weekOffset}`}
              className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${
                !staffFilter ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-[var(--color-line)] bg-white text-gray-600'
              }`}
            >
              Everyone
            </Link>
            {staff.map((member) => (
              <Link
                key={member.id}
                href={`/dashboard/calendar?week=${weekOffset}&staff=${member.id}`}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] ${
                  staffFilter === member.id
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                    : 'border-[var(--color-line)] bg-white text-gray-600'
                }`}
              >
                <span className="dot" style={{ background: member.color }} />
                {member.name.split(' ')[0]}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <Card pad={false} className="overflow-hidden">
        <div className="overflow-x-auto scroll-thin">
          <div className="min-w-[860px]">
            {/* day headers */}
            <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-[var(--color-line)] bg-[#fbfcfe]">
              <div />
              {dates.map((date) => {
                const isToday = date === today
                return (
                  <div key={date} className="border-l border-[var(--color-line)] px-2 py-2 text-center">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                      {DateTime.fromISO(date, { zone }).toFormat('ccc')}
                    </p>
                    <p
                      className={`num mt-0.5 text-[14px] font-semibold ${
                        isToday ? 'text-indigo-600' : 'text-gray-800'
                      }`}
                    >
                      {DateTime.fromISO(date, { zone }).toFormat('d')}
                    </p>
                  </div>
                )
              })}
            </div>

            {/* time grid */}
            <div className="grid grid-cols-[56px_repeat(7,1fr)]">
              <div>
                {hours.map((hour) => (
                  <div
                    key={hour}
                    className="relative border-b border-[#f1f3f9] pr-1.5 text-right"
                    style={{ height: HOUR_HEIGHT }}
                  >
                    <span className="num absolute -top-1.5 right-1.5 text-[10.5px] text-gray-400">
                      {String(hour).padStart(2, '0')}:00
                    </span>
                  </div>
                ))}
              </div>

              {dates.map((date) => {
                const dayAppointments = (byDate.get(date) ?? []).filter(
                  (a) => a.status !== 'CANCELLED',
                )
                const lanes = layoutDay(dayAppointments)
                const isToday = date === today

                return (
                  <div
                    key={date}
                    className={`relative border-l border-[var(--color-line)] ${isToday ? 'bg-indigo-50/25' : ''}`}
                    style={{ height: hours.length * HOUR_HEIGHT }}
                  >
                    {hours.map((hour) => (
                      <div
                        key={hour}
                        className="absolute inset-x-0 border-b border-[#f1f3f9]"
                        style={{ top: (hour - HOUR_START) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                      />
                    ))}

                    {dayAppointments.map((appointment, index) => {
                      const startMin = localMinutesOf(appointment.startsAt, zone)
                      const endMin = localMinutesOf(appointment.endsAt, zone)
                      const top = ((startMin - HOUR_START * 60) / 60) * HOUR_HEIGHT
                      const height = Math.max(20, ((endMin - startMin) / 60) * HOUR_HEIGHT - 3)
                      if (top < 0) return null
                      const { lane, lanes: laneCount } = lanes[index]
                      const width = 100 / laneCount
                      return (
                        <Link
                          key={appointment.id}
                          href={`/dashboard/appointments/${appointment.id}`}
                          className="group absolute overflow-hidden rounded-[7px] px-1.5 py-1 text-[10.5px] leading-tight text-white shadow-sm transition-transform hover:z-10 hover:scale-[1.02]"
                          style={{
                            top,
                            height,
                            left: `${lane * width}%`,
                            width: `calc(${width}% - 3px)`,
                            background: appointment.staff.color,
                          }}
                          title={`${appointment.customer.name} — ${appointment.service.name}`}
                        >
                          <p className="num font-semibold">
                            {DateTime.fromJSDate(appointment.startsAt, { zone: 'utc' })
                              .setZone(zone)
                              .toFormat('HH:mm')}
                          </p>
                          <p className="truncate opacity-95">{appointment.customer.name}</p>
                          {height > 44 ? (
                            <p className="truncate text-[9.5px] opacity-80">{appointment.service.name}</p>
                          ) : null}
                          {appointment.status === 'PENDING_PAYMENT' && height > 34 ? (
                            <p className="mt-0.5 inline-flex rounded bg-black/25 px-1 text-[9px]">unpaid</p>
                          ) : null}
                        </Link>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </Card>

      {/* agenda fallback for narrow screens + a11y */}
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-gray-900">Week agenda</h3>
          <span className="text-[11.5px] text-gray-500">The grid, as a list</span>
        </div>
        <div className="mt-3 space-y-4">
          {dates.map((date) => {
            const list = byDate.get(date) ?? []
            if (list.length === 0) return null
            return (
              <div key={date}>
                <p className="label">{DateTime.fromISO(date, { zone }).toFormat('cccc, LLL d')}</p>
                <div className="mt-1.5 space-y-1.5">
                  {list.map((appointment) => (
                    <Link
                      key={appointment.id}
                      href={`/dashboard/appointments/${appointment.id}`}
                      className="flex items-center gap-2.5 rounded-lg border border-[var(--color-line)] px-2.5 py-1.5 hover:bg-gray-50"
                    >
                      <span className="num w-[44px] shrink-0 text-[12px] font-medium text-gray-700">
                        {DateTime.fromJSDate(appointment.startsAt, { zone: 'utc' })
                          .setZone(zone)
                          .toFormat('HH:mm')}
                      </span>
                      <span className="dot" style={{ background: appointment.staff.color }} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">
                        {appointment.customer.name} · {appointment.service.name}
                      </span>
                      <span className="hidden text-[11.5px] text-gray-500 sm:inline">{appointment.staff.name}</span>
                      <StatusBadge status={appointment.status} />
                    </Link>
                  ))}
                </div>
              </div>
            )
          })}
          {appointments.length === 0 ? (
            <EmptyState title="Nothing booked this week" hint="Share /book/northside to fill the calendar." />
          ) : null}
        </div>
      </Card>
    </div>
  )
}
