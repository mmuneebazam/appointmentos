/**
 * Read models for the dashboard.
 *
 * Every function takes `orgId` as its first argument and includes it in the
 * `where` clause. That is the tenant-isolation contract: there is no read path
 * that can fetch another organisation's row, because the caller cannot express
 * such a query.
 */
import { prisma } from '@/lib/db'
import { percentage } from '@/lib/money'
import { DateTime } from 'luxon'
import { dayBounds, localDateRange, addLocalDays } from '@/lib/time'

export async function dashboardSummary(input: { orgId: string; zone: string; now?: Date }) {
  const now = input.now ?? new Date()
  const today = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(input.zone).toISODate()!
  const { start: todayStart, end: todayEnd } = dayBounds(today, input.zone)
  const weekEnd = dayBounds(addLocalDays(today, 7), input.zone).end
  const monthStart = dayBounds(addLocalDays(today, -30), input.zone).start
  const prevMonthStart = dayBounds(addLocalDays(today, -60), input.zone).start

  const [
    todayAppointments,
    upcoming,
    pendingPayment,
    completedLast30,
    completedPrev30,
    revenueLast30,
    revenuePrev30,
    cancelsLast30,
    totalLast30,
    queue,
    deadLetters,
  ] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        orgId: input.orgId,
        status: { in: ['CONFIRMED', 'PENDING_PAYMENT', 'COMPLETED'] },
        startsAt: { gte: todayStart, lt: todayEnd },
      },
      include: { service: true, staff: true, customer: true },
      orderBy: { startsAt: 'asc' },
    }),
    prisma.appointment.count({
      where: { orgId: input.orgId, status: 'CONFIRMED', startsAt: { gte: now, lt: weekEnd } },
    }),
    prisma.appointment.count({ where: { orgId: input.orgId, status: 'PENDING_PAYMENT' } }),
    prisma.appointment.count({
      where: { orgId: input.orgId, status: 'COMPLETED', startsAt: { gte: monthStart } },
    }),
    prisma.appointment.count({
      where: {
        orgId: input.orgId,
        status: 'COMPLETED',
        startsAt: { gte: prevMonthStart, lt: monthStart },
      },
    }),
    prisma.payment.aggregate({
      where: { orgId: input.orgId, status: 'SUCCEEDED', capturedAt: { gte: monthStart } },
      _sum: { amountCents: true },
    }),
    prisma.payment.aggregate({
      where: {
        orgId: input.orgId,
        status: 'SUCCEEDED',
        capturedAt: { gte: prevMonthStart, lt: monthStart },
      },
      _sum: { amountCents: true },
    }),
    prisma.appointment.count({
      where: { orgId: input.orgId, status: 'CANCELLED', createdAt: { gte: monthStart } },
    }),
    prisma.appointment.count({ where: { orgId: input.orgId, createdAt: { gte: monthStart } } }),
    prisma.job.groupBy({ by: ['status'], where: { orgId: input.orgId }, _count: { _all: true } }),
    prisma.notification.count({ where: { orgId: input.orgId, status: 'DEAD_LETTER' } }),
  ])

  const revenueCents = revenueLast30._sum.amountCents ?? 0
  const prevRevenueCents = revenuePrev30._sum.amountCents ?? 0
  const revenueTrend =
    prevRevenueCents === 0
      ? null
      : Math.round(((revenueCents - prevRevenueCents) / prevRevenueCents) * 1000) / 10

  return {
    today,
    todayAppointments,
    upcoming,
    pendingPayment,
    completedLast30,
    completedTrend:
      completedPrev30 === 0
        ? null
        : Math.round(((completedLast30 - completedPrev30) / completedPrev30) * 1000) / 10,
    revenueCents,
    revenueTrend,
    cancellationRate: percentage(cancelsLast30, Math.max(1, totalLast30)),
    queueByStatus: Object.fromEntries(queue.map((q) => [q.status, q._count._all])) as Record<string, number>,
    deadLetterNotifications: deadLetters,
  }
}

export async function calendarBookings(input: {
  orgId: string
  fromDate: string
  days: number
  zone: string
  staffId?: string
}) {
  const dates = localDateRange(input.fromDate, addLocalDays(input.fromDate, input.days - 1))
  const start = dayBounds(dates[0], input.zone).start
  const end = dayBounds(dates[dates.length - 1], input.zone).end

  const appointments = await prisma.appointment.findMany({
    where: {
      orgId: input.orgId,
      startsAt: { gte: start, lt: end },
      ...(input.staffId ? { staffId: input.staffId } : {}),
    },
    include: { service: true, staff: true, customer: true },
    orderBy: { startsAt: 'asc' },
  })
  return { dates, appointments }
}

export async function appointmentDetail(orgId: string, appointmentId: string) {
  return prisma.appointment.findFirst({
    where: { id: appointmentId, orgId },
    include: {
      service: true,
      staff: true,
      customer: true,
      location: true,
      org: true,
      payments: { orderBy: { createdAt: 'desc' }, include: { refunds: true } },
      notifications: { orderBy: { createdAt: 'desc' } },
      calendarEvents: true,
    },
  })
}

export async function listAppointments(input: {
  orgId: string
  status?: string
  staffId?: string
  take?: number
  skip?: number
}) {
  const where = {
    orgId: input.orgId,
    ...(input.status && input.status !== 'ALL' ? { status: input.status } : {}),
    ...(input.staffId ? { staffId: input.staffId } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { service: true, staff: true, customer: true },
      orderBy: { startsAt: 'desc' },
      take: input.take ?? 25,
      skip: input.skip ?? 0,
    }),
    prisma.appointment.count({ where }),
  ])
  return { rows, total }
}

export async function customerDirectory(input: { orgId: string; search?: string }) {
  const customers = await prisma.customer.findMany({
    where: {
      orgId: input.orgId,
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search } },
              { email: { contains: input.search } },
            ],
          }
        : {}),
    },
    include: {
      appointments: {
        select: { id: true, startsAt: true, status: true, priceCents: true },
        orderBy: { startsAt: 'desc' },
      },
    },
    orderBy: { name: 'asc' },
    take: 100,
  })
  return customers.map((c) => {
    const completed = c.appointments.filter((a) => a.status === 'COMPLETED')
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      createdAt: c.createdAt,
      totalBookings: c.appointments.length,
      completedBookings: completed.length,
      lifetimeValueCents: completed.reduce((sum, a) => sum + a.priceCents, 0),
      lastVisit: c.appointments.find((a) => a.status === 'COMPLETED')?.startsAt ?? null,
      nextVisit:
        c.appointments.find((a) => a.startsAt > new Date() && a.status === 'CONFIRMED')?.startsAt ?? null,
    }
  })
}

export async function auditFeed(input: { orgId: string; take?: number }) {
  return prisma.auditLog.findMany({
    where: { orgId: input.orgId },
    orderBy: { createdAt: 'desc' },
    take: input.take ?? 50,
  })
}

export async function notificationLog(input: { orgId: string; take?: number }) {
  return prisma.notification.findMany({
    where: { orgId: input.orgId },
    include: { appointment: { include: { customer: true } } },
    orderBy: { createdAt: 'desc' },
    take: input.take ?? 50,
  })
}

export async function operationsSnapshot(input: { orgId: string }) {
  const [jobs, webhooks, holds, mappings, accounts] = await Promise.all([
    prisma.job.findMany({ where: { orgId: input.orgId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.webhookEvent.findMany({ where: { orgId: input.orgId }, orderBy: { receivedAt: 'desc' }, take: 25 }),
    prisma.slotHold.findMany({
      where: { orgId: input.orgId, status: 'ACTIVE' },
      include: { service: true, staff: true },
      orderBy: { expiresAt: 'asc' },
    }),
    prisma.calendarEventMapping.findMany({
      where: { appointment: { orgId: input.orgId } },
      take: 20,
      orderBy: { lastSyncedAt: 'desc' },
    }),
    prisma.externalAccount.findMany({ where: { orgId: input.orgId } }),
  ])
  return { jobs, webhooks, holds, mappings, accounts }
}

export async function revenueByDay(input: { orgId: string; zone: string; days?: number; now?: Date }) {
  const days = input.days ?? 14
  const now = input.now ?? new Date()
  const today = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(input.zone).toISODate()!
  const from = addLocalDays(today, -(days - 1))
  const start = dayBounds(from, input.zone).start

  const payments = await prisma.payment.findMany({
    where: { orgId: input.orgId, status: 'SUCCEEDED', capturedAt: { gte: start } },
    select: { amountCents: true, capturedAt: true },
  })

  const buckets = new Map<string, number>()
  for (const date of localDateRange(from, today)) buckets.set(date, 0)
  for (const payment of payments) {
    if (!payment.capturedAt) continue
    const key = DateTime.fromJSDate(payment.capturedAt, { zone: 'utc' }).setZone(input.zone).toISODate()!
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + payment.amountCents)
  }
  return [...buckets.entries()].map(([date, cents]) => ({ date, cents }))
}

export async function staffWorkload(input: { orgId: string; zone: string; now?: Date }) {
  const now = input.now ?? new Date()
  const today = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(input.zone).toISODate()!
  const weekEnd = dayBounds(addLocalDays(today, 7), input.zone).end

  const staff = await prisma.staff.findMany({
    where: { orgId: input.orgId, active: true },
    include: {
      appointments: {
        where: { status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startsAt: { gte: now, lt: weekEnd } },
        select: { startsAt: true, endsAt: true },
      },
      workingHours: true,
    },
  })

  return staff.map((s) => {
    const bookedMinutes = s.appointments.reduce(
      (sum, a) => sum + Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000),
      0,
    )
    const capacityMinutes = s.workingHours.reduce((sum, w) => sum + (w.endMin - w.startMin), 0)
    return {
      id: s.id,
      name: s.name,
      title: s.title,
      color: s.color,
      upcomingCount: s.appointments.length,
      bookedMinutes,
      capacityMinutes,
      utilisation: percentage(bookedMinutes, Math.max(1, capacityMinutes)),
    }
  })
}

export async function waitlistCandidates(input: { orgId: string; appointmentId: string }) {
  // Everyone who has booked before but has no upcoming appointment — the honest
  // shortlist for "a slot just opened".
  const appointment = await prisma.appointment.findFirst({
    where: { id: input.appointmentId, orgId: input.orgId },
    include: { service: true },
  })
  if (!appointment) return []

  return prisma.customer.findMany({
    where: {
      orgId: input.orgId,
      appointments: {
        some: { serviceId: appointment.serviceId, status: 'COMPLETED' },
        none: {
          status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] },
          startsAt: { gt: new Date() },
        },
      },
    },
    take: 20,
    orderBy: { name: 'asc' },
  })
}
