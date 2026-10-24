/**
 * Availability engine.
 *
 * Pure-ish: given a service, a local date and a zone it returns bookable start
 * times. It is used for two different jobs and must agree with itself in both:
 *
 *   1. The customer-facing "pick a time" grid (fast, read-only).
 *   2. The authoritative re-check performed *inside* the booking transaction
 *      (a grid rendered 4 minutes ago is not evidence that a slot is free).
 *
 * Anything the engine says is bookable must survive the unique-index collision
 * test in src/server/booking.ts — the engine narrows the search, the database
 * makes the final call.
 */
import type { Prisma } from '@prisma/client'
import { DateTime } from 'luxon'
import {
  addLocalDays,
  dayBounds,
  isDstTransitionDate,
  localDateRange,
  localMinutesOf,
  weekdayOf,
  zonedInstant,
} from '@/lib/time'
import { OCCUPYING_STATUSES } from '@/lib/domain'

export const SLOT_GRANULARITY_MIN = 15
/** Nobody books an appointment 5 minutes from now; staff need notice. */
export const MIN_LEAD_TIME_MIN = 30
/** How far ahead the public booking page will look. */
export const MAX_ADVANCE_DAYS = 90

export type Db = Prisma.TransactionClient

export interface Slot {
  startsAt: string // ISO UTC
  endsAt: string
  label: string // "09:00"
  endLabel: string
  staffId: string
  staffName: string
  remainingSeats: number
}

export interface StaffDay {
  staffId: string
  staffName: string
  color: string
  slots: Slot[]
}

export interface AvailabilityResult {
  date: string
  timezone: string
  serviceId: string
  serviceName: string
  durationMin: number
  staff: StaffDay[]
  reasonIfEmpty: string | null
}

/**
 * Every 15-minute tick covered by [blockStart, blockEnd).
 * The end is rounded up so a 45-minute service + 10-minute buffer still owns
 * the tick it spills into — otherwise the next booking could start inside it.
 */
export function occupancyTicks(blockStart: Date, blockEnd: Date): Date[] {
  const step = SLOT_GRANULARITY_MIN * 60_000
  const start = Math.floor(blockStart.getTime() / step) * step
  const end = Math.ceil(blockEnd.getTime() / step) * step
  const ticks: Date[] = []
  for (let t = start; t < end; t += step) ticks.push(new Date(t))
  return ticks
}

interface Window {
  startMin: number
  endMin: number
}

/** Working windows for one staff member on one local date, after exceptions. */
export function resolveWindows(opts: {
  workingHours: Array<{ weekday: number; startMin: number; endMin: number }>
  exceptions: Array<{ kind: string; startMin: number | null; endMin: number | null }>
  weekday: number
}): { windows: Window[]; blocked: boolean } {
  const { workingHours, exceptions, weekday } = opts

  const leave = exceptions.find((e) => e.kind === 'LEAVE' || e.kind === 'HOLIDAY')
  if (leave) return { windows: [], blocked: true }

  const recurring = workingHours
    .filter((w) => w.weekday === weekday && w.endMin > w.startMin)
    .map((w) => ({ startMin: w.startMin, endMin: w.endMin }))

  const extra = exceptions
    .filter((e) => e.kind === 'EXTRA_HOURS' && e.startMin != null && e.endMin != null)
    .map((e) => ({ startMin: e.startMin!, endMin: e.endMin! }))

  const merged = [...recurring, ...extra].sort((a, b) => a.startMin - b.startMin)
  const windows: Window[] = []
  for (const w of merged) {
    const last = windows[windows.length - 1]
    if (last && w.startMin <= last.endMin) last.endMin = Math.max(last.endMin, w.endMin)
    else windows.push({ ...w })
  }
  return { windows, blocked: false }
}

function overlapsAny(start: Date, end: Date, intervals: Array<{ s: Date; e: Date }>): boolean {
  for (const i of intervals) if (start < i.e && i.s < end) return true
  return false
}

export async function computeAvailability(
  db: Db,
  input: {
    orgId: string
    serviceId: string
    localDate: string
    staffId?: string
    now?: Date
    /**
     * Ignore this hold (and the ticks it owns). Needed when the customer is
     * converting their own hold into a booking: the slot is "taken" by them,
     * and failing the re-check would make checkout impossible.
     */
    ignoreHoldId?: string
  },
): Promise<AvailabilityResult> {
  const now = input.now ?? new Date()
  const service = await db.service.findFirst({
    where: { id: input.serviceId, orgId: input.orgId, active: true },
  })
  if (!service) throw new Error('Service not found')

  const org = await db.organization.findUniqueOrThrow({ where: { id: input.orgId } })
  const location = await db.location.findFirst({
    where: { orgId: input.orgId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  if (!location) throw new Error('Organization has no location configured')
  const zone = location.timezone || org.timezone

  const empty = (reason: string): AvailabilityResult => ({
    date: input.localDate,
    timezone: zone,
    serviceId: service.id,
    serviceName: service.name,
    durationMin: service.durationMin,
    staff: [],
    reasonIfEmpty: reason,
  })

  const todayLocal = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(zone).toISODate()!
  const maxDate = addLocalDays(todayLocal, MAX_ADVANCE_DAYS)
  if (input.localDate < todayLocal) return empty('That date has already passed.')
  if (input.localDate > maxDate) return empty(`Bookings open ${MAX_ADVANCE_DAYS} days ahead.`)

  const staffWhere: Prisma.StaffWhereInput = {
    orgId: input.orgId,
    active: true,
    services: { some: { serviceId: service.id } },
    ...(input.staffId ? { id: input.staffId } : {}),
  }
  const staffList = await db.staff.findMany({
    where: staffWhere,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true },
  })
  if (staffList.length === 0) return empty('No team member offers this service.')

  const staffIds = staffList.map((s) => s.id)
  const weekday = weekdayOf(input.localDate)
  const { start: dayStart, end: dayEnd } = dayBounds(input.localDate, zone)
  const blockLen = service.bufferBeforeMin + service.durationMin + service.bufferAfterMin

  // Hard ceiling on daily bookings for a group service.
  const seatsLeftFor = (confirmedSeats: number) =>
    service.isGroup ? Math.max(0, service.maxParticipants - confirmedSeats) : 1

  const [workingHours, exceptions, appointments, holds, locks] = await Promise.all([
    db.workingHours.findMany({ where: { staffId: { in: staffIds }, weekday } }),
    db.scheduleException.findMany({ where: { staffId: { in: staffIds }, date: input.localDate } }),
    db.appointment.findMany({
      where: {
        orgId: input.orgId,
        staffId: { in: staffIds },
        status: { in: OCCUPYING_STATUSES },
        blockStartsAt: { lt: dayEnd },
        blockEndsAt: { gt: dayStart },
      },
      select: { staffId: true, blockStartsAt: true, blockEndsAt: true, seats: true, startsAt: true },
    }),
    db.slotHold.findMany({
      where: {
        orgId: input.orgId,
        staffId: { in: staffIds },
        status: 'ACTIVE',
        expiresAt: { gt: now },
        blockStartsAt: { lt: dayEnd },
        blockEndsAt: { gt: dayStart },
        ...(input.ignoreHoldId ? { id: { not: input.ignoreHoldId } } : {}),
      },
      select: { staffId: true, blockStartsAt: true, blockEndsAt: true },
    }),
    db.slotLock.findMany({
      where: {
        staffId: { in: staffIds },
        tickAt: { gte: dayStart, lt: dayEnd },
        ...(input.ignoreHoldId ? { OR: [{ holdId: null }, { holdId: { not: input.ignoreHoldId } }] } : {}),
      },
      select: { staffId: true, tickAt: true },
    }),
  ])

  const busyTicksByStaff = new Map<string, Set<number>>()
  for (const lock of locks) {
    const set = busyTicksByStaff.get(lock.staffId) ?? new Set<number>()
    set.add(lock.tickAt.getTime())
    busyTicksByStaff.set(lock.staffId, set)
  }

  const staffDays: StaffDay[] = []
  let anyWorkingHours = false

  for (const staff of staffList) {
    const { windows, blocked } = resolveWindows({
      workingHours: workingHours.filter((w) => w.staffId === staff.id),
      exceptions: exceptions.filter((e) => e.staffId === staff.id),
      weekday,
    })
    if (blocked || windows.length === 0) continue
    anyWorkingHours = true

    const staffAppointments = appointments.filter((a) => a.staffId === staff.id)
    const busy = [
      ...staffAppointments.map((a) => ({ s: a.blockStartsAt, e: a.blockEndsAt })),
      ...holds
        .filter((h) => h.staffId === staff.id)
        .map((h) => ({ s: h.blockStartsAt, e: h.blockEndsAt })),
    ]
    const busyTicks = busyTicksByStaff.get(staff.id) ?? new Set<number>()

    const slots: Slot[] = []
    for (const window of windows) {
      for (
        let startMin = window.startMin;
        startMin + blockLen <= window.endMin;
        startMin += SLOT_GRANULARITY_MIN
      ) {
        const serviceStartMin = startMin + service.bufferBeforeMin
        const blockStartLocal = zonedInstant(input.localDate, startMin, zone)
        const serviceStart = zonedInstant(input.localDate, serviceStartMin, zone)

        // Spring-forward gap: the wall clock skipped this time. Skip it too.
        if (blockStartLocal.hour * 60 + blockStartLocal.minute !== startMin) continue
        if (serviceStart.hour * 60 + serviceStart.minute !== serviceStartMin) continue

        const blockStart = blockStartLocal.toUTC().toJSDate()
        const serviceEnd = serviceStart.plus({ minutes: service.durationMin })
        const serviceEndMin = serviceEnd.hour * 60 + serviceEnd.minute
        const blockEnd = serviceEnd.plus({ minutes: service.bufferAfterMin }).toUTC().toJSDate()

        if (blockStart.getTime() < now.getTime() + MIN_LEAD_TIME_MIN * 60_000) continue
        if (overlapsAny(blockStart, blockEnd, busy)) continue

        const ticks = occupancyTicks(blockStart, blockEnd)
        if (ticks.some((t) => busyTicks.has(t.getTime()))) continue

        // Group services: reuse a confirmed appointment that starts at the same
        // instant if seats remain, instead of consuming a second slot.
        const existingGroup = staffAppointments.find(
          (a) => a.startsAt.getTime() === serviceStart.toUTC().toMillis(),
        )
        const confirmedSeats = staffAppointments
          .filter((a) => a.startsAt.getTime() === serviceStart.toUTC().toMillis())
          .reduce((sum, a) => sum + a.seats, 0)
        const remainingSeats = service.isGroup
          ? seatsLeftFor(confirmedSeats)
          : existingGroup
            ? 0
            : 1
        if (service.isGroup && remainingSeats <= 0) continue

        slots.push({
          startsAt: serviceStart.toUTC().toISO()!,
          endsAt: serviceEnd.toUTC().toISO()!,
          label: serviceStart.toFormat('HH:mm'),
          endLabel: serviceEnd.toFormat('HH:mm'),
          staffId: staff.id,
          staffName: staff.name,
          remainingSeats,
        })
        // NOTE: candidates are step-aligned, so consecutive starts cannot
        // overlap each other. We must *not* consume their ticks here — doing so
        // would offer only one booking per working window.
        void serviceEndMin
      }
    }

    if (slots.length > 0) {
      staffDays.push({ staffId: staff.id, staffName: staff.name, color: staff.color, slots })
    }
  }

  if (staffDays.length === 0) {
    return empty(
      anyWorkingHours
        ? 'Fully booked for this date — try another day or join the waitlist.'
        : 'The team is not scheduled on this date.',
    )
  }

  // Union view for UIs that just want "times available with anyone".
  return {
    date: input.localDate,
    timezone: zone,
    serviceId: service.id,
    serviceName: service.name,
    durationMin: service.durationMin,
    staff: staffDays,
    reasonIfEmpty: null,
  }
}

/** Week-at-a-glance availability used by the booking calendar strip. */
export async function availabilitySummary(
  db: Db,
  input: { orgId: string; serviceId: string; fromDate: string; days?: number; now?: Date },
): Promise<Array<{ date: string; openSlots: number }>> {
  const days = input.days ?? 14
  const dates = localDateRange(input.fromDate, addLocalDays(input.fromDate, days - 1))
  const out: Array<{ date: string; openSlots: number }> = []
  for (const date of dates) {
    const result = await computeAvailability(db, {
      orgId: input.orgId,
      serviceId: input.serviceId,
      localDate: date,
      now: input.now,
    })
    const count = result.staff.reduce((sum, s) => sum + s.slots.length, 0)
    out.push({ date, openSlots: count })
  }
  return out
}

export function describeDst(localDate: string, zone: string): string | null {
  return isDstTransitionDate(localDate, zone) ? 'DST transition day' : null
}
