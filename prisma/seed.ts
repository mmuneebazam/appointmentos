/**
 * Deterministic demo data.
 *
 * The seed is written to satisfy the same invariants the application enforces:
 * occupancy ticks exist for every live appointment, no two appointment blocks
 * overlap, and amounts are integers in minor units. A reviewer should be able to
 * reset, log in, and immediately have something meaningful to click.
 *
 * Run: npm run db:reset
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { occupancyTicks } from '../src/server/availability'

const prisma = new PrismaClient()
const PASSWORD = 'demo1234'

function hash(password: string) {
  return bcrypt.hashSync(password, 10)
}

async function wipe() {
  // Order matters: children before parents (SQLite has no TRUNCATE CASCADE).
  await prisma.job.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.webhookEvent.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.calendarEventMapping.deleteMany()
  await prisma.externalAccount.deleteMany()
  await prisma.refund.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.slotLock.deleteMany()
  await prisma.slotHold.deleteMany()
  await prisma.appointmentParticipant.deleteMany()
  await prisma.appointment.deleteMany()
  await prisma.scheduleException.deleteMany()
  await prisma.workingHours.deleteMany()
  await prisma.staffService.deleteMany()
  await prisma.resource.deleteMany()
  await prisma.service.deleteMany()
  await prisma.staff.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.location.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.organization.deleteMany()
  await prisma.user.deleteMany()
}

interface SeedAppointment {
  serviceId: string
  staffId: string
  customerId: string
  startsAt: Date
  endsAt: Date
  priceCents: number
  status: string
  paid: boolean
  depositCents: number
  notes?: string
}

/** Reject a generated appointment that would double-book a staff member. */
function isFree(placed: Array<{ staffId: string; start: number; end: number }>, staffId: string, start: number, end: number) {
  return !placed.some((p) => p.staffId === staffId && start < p.end && p.start < end)
}

async function main() {
  console.log('Seeding AppointmentOS…')
  await wipe()

  const passwordHash = hash(PASSWORD)

  // ── users ──────────────────────────────────────────────────────────
  const [owner, manager, therapist] = await Promise.all([
    prisma.user.create({
      data: { email: 'owner@northside.test', name: 'Amara Osei', passwordHash, timezone: 'America/New_York' },
    }),
    prisma.user.create({
      data: { email: 'manager@northside.test', name: 'Tomas Brandt', passwordHash, timezone: 'America/New_York' },
    }),
    prisma.user.create({
      data: { email: 'jonas@northside.test', name: 'Jonas Weber', passwordHash, timezone: 'America/New_York' },
    }),
  ])

  // A completely separate tenant, so cross-tenant isolation can be demonstrated.
  const outsider = await prisma.user.create({
    data: { email: 'barber@riverside.test', name: 'Riverside Owner', passwordHash, timezone: 'Europe/London' },
  })

  // ── org A ──────────────────────────────────────────────────────────
  const org = await prisma.organization.create({
    data: {
      name: 'Northside Wellness Studio',
      slug: 'northside',
      timezone: 'America/New_York',
      currency: 'USD',
      brandColor: '#4f46e5',
      cancellationWindowHrs: 24,
      depositRequired: true,
      slotHoldMinutes: 10,
    },
  })

  await Promise.all([
    prisma.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'OWNER' } }),
    prisma.membership.create({ data: { orgId: org.id, userId: manager.id, role: 'ADMIN' } }),
    prisma.membership.create({ data: { orgId: org.id, userId: therapist.id, role: 'STAFF' } }),
  ])

  const location = await prisma.location.create({
    data: {
      orgId: org.id,
      name: 'Northside Studio — Suite 4',
      timezone: 'America/New_York',
      address: '418 Bergen St, Brooklyn, NY',
      isDefault: true,
    },
  })

  // ── services ───────────────────────────────────────────────────────
  const [initial, followUp, massage, groupYoga] = await Promise.all([
    prisma.service.create({
      data: {
        orgId: org.id,
        name: 'Initial Consultation',
        description: '60-minute assessment and treatment plan.',
        durationMin: 60,
        bufferBeforeMin: 0,
        bufferAfterMin: 15,
        priceCents: 12000,
        depositCents: 4000,
      },
    }),
    prisma.service.create({
      data: {
        orgId: org.id,
        name: 'Follow-up Session',
        description: '30-minute progress check.',
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 10,
        priceCents: 6000,
        depositCents: 2000,
      },
    }),
    prisma.service.create({
      data: {
        orgId: org.id,
        name: 'Sports Massage',
        description: '45-minute deep tissue session.',
        durationMin: 45,
        bufferBeforeMin: 5,
        bufferAfterMin: 15,
        priceCents: 8500,
        depositCents: 2500,
      },
    }),
    prisma.service.create({
      data: {
        orgId: org.id,
        name: 'Group Mobility Class',
        description: 'Small-group class, max 8 people.',
        durationMin: 60,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        priceCents: 2500,
        depositCents: 0,
        isGroup: true,
        maxParticipants: 8,
      },
    }),
  ])

  // ── staff ──────────────────────────────────────────────────────────
  const amina = await prisma.staff.create({
    data: { orgId: org.id, locationId: location.id, name: 'Dr. Amina Rahman', title: 'Chiropractor', email: 'amina@northside.test', color: '#6366f1' },
  })
  const jonas = await prisma.staff.create({
    data: { orgId: org.id, locationId: location.id, userId: therapist.id, name: 'Jonas Weber', title: 'Massage Therapist', email: 'jonas@northside.test', color: '#0ea5e9' },
  })
  const priya = await prisma.staff.create({
    data: { orgId: org.id, locationId: location.id, name: 'Priya Nair', title: 'Movement Coach', email: 'priya@northside.test', color: '#10b981' },
  })

  await prisma.staffService.createMany({
    data: [
      { staffId: amina.id, serviceId: initial.id },
      { staffId: amina.id, serviceId: followUp.id },
      { staffId: jonas.id, serviceId: massage.id },
      { staffId: jonas.id, serviceId: followUp.id },
      { staffId: priya.id, serviceId: groupYoga.id },
      { staffId: priya.id, serviceId: followUp.id },
    ],
  })

  // Mon–Fri 09:00–12:00 and 13:00–17:00 (lunch is its own gap), Sat 10:00–14:00.
  const standardHours: Array<{ weekday: number; startMin: number; endMin: number }> = []
  for (const weekday of [1, 2, 3, 4, 5]) {
    standardHours.push({ weekday, startMin: 540, endMin: 720 })
    standardHours.push({ weekday, startMin: 780, endMin: 1020 })
  }
  standardHours.push({ weekday: 6, startMin: 600, endMin: 840 })

  for (const staff of [amina, jonas]) {
    await prisma.workingHours.createMany({
      data: standardHours.map((h) => ({ ...h, staffId: staff.id, locationId: location.id })),
    })
  }
  // Priya only runs classes on Tue/Thu evenings and Saturday mornings.
  await prisma.workingHours.createMany({
    data: [
      { staffId: priya.id, locationId: location.id, weekday: 2, startMin: 1020, endMin: 1200 },
      { staffId: priya.id, locationId: location.id, weekday: 4, startMin: 1020, endMin: 1200 },
      { staffId: priya.id, locationId: location.id, weekday: 6, startMin: 540, endMin: 720 },
    ],
  })

  await prisma.resource.createMany({
    data: [
      { orgId: org.id, locationId: location.id, name: 'Treatment Room A', kind: 'ROOM' },
      { orgId: org.id, locationId: location.id, name: 'Treatment Room B', kind: 'ROOM' },
      { orgId: org.id, locationId: location.id, name: 'Studio Floor', kind: 'ROOM' },
    ],
  })

  const inDays = (n: number) => DateTime.now().setZone('America/New_York').plus({ days: n })

  await prisma.scheduleException.createMany({
    data: [
      {
        staffId: priya.id,
        date: inDays(5).toISODate()!,
        kind: 'LEAVE',
        note: 'Continuing education course',
      },
      {
        staffId: amina.id,
        date: inDays(9).toISODate()!,
        kind: 'EXTRA_HOURS',
        startMin: 1080,
        endMin: 1260,
        note: 'Late clinic added for backlog',
      },
    ],
  })

  // ── customers ──────────────────────────────────────────────────────
  const customerSeeds = [
    ['Grace Lindqvist', 'grace.lindqvist@example.com', '+1 347 555 0110'],
    ['Marcus Bell', 'marcus.bell@example.com', '+1 347 555 0111'],
    ['Yuki Tanaka', 'yuki.tanaka@example.com', '+1 347 555 0112'],
    ['Omar Haddad', 'omar.haddad@example.com', null],
    ['Elena Rossi', 'elena.rossi@example.com', '+1 347 555 0114'],
    ['Daniel Okafor', 'daniel.okafor@example.com', '+1 347 555 0115'],
    ['Sofia Marchetti', 'sofia.marchetti@example.com', null],
    ['Noah Feldman', 'noah.feldman@example.com', '+1 347 555 0117'],
    ['Aisha Bello', 'aisha.bello@example.com', '+1 347 555 0118'],
    ['Liam Doherty', 'liam.doherty@example.com', null],
    ['Hana Kim', 'hana.kim@example.com', '+1 347 555 0120'],
    ['Victor Alvarez', 'victor.alvarez@example.com', '+1 347 555 0121'],
  ] as const

  const customers = []
  for (const [name, email, phone] of customerSeeds) {
    customers.push(
      await prisma.customer.create({
        data: { orgId: org.id, name, email, phone, timezone: 'America/New_York' },
      }),
    )
  }

  // ── appointments ───────────────────────────────────────────────────
  // Every (service, staff) pairing below is one the StaffService table allows,
  // because the availability engine would refuse it otherwise.
  const pairs = [
    { service: initial, staff: amina },
    { service: massage, staff: jonas },
    { service: followUp, staff: amina },
    { service: groupYoga, staff: priya },
    { service: followUp, staff: jonas },
    { service: massage, staff: jonas },
  ]

  const plan: SeedAppointment[] = []

  // Past two weeks: completed and paid.
  for (let dayOffset = -14; dayOffset <= -1; dayOffset++) {
    const date = inDays(dayOffset)
    if (date.weekday === 7) continue
    const count = 2 + (Math.abs(dayOffset) % 2)
    for (let i = 0; i < count; i++) {
      const pair = pairs[(Math.abs(dayOffset) + i) % pairs.length]
      const start = date.set({ hour: 9 + i * 2, minute: 0, second: 0, millisecond: 0 })
      plan.push({
        serviceId: pair.service.id,
        staffId: pair.staff.id,
        customerId: customers[(Math.abs(dayOffset) + i) % customers.length].id,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ minutes: pair.service.durationMin }).toJSDate(),
        priceCents: pair.service.priceCents,
        status: 'COMPLETED',
        paid: true,
        depositCents: pair.service.depositCents,
      })
    }
  }

  // Next two weeks: a realistic confirmed pipeline.
  const pattern: Array<[number, number, number, number]> = [
    // day, hour, minute, index into `pairs`
    [1, 9, 0, 0], [1, 11, 0, 1], [1, 14, 0, 2],
    [2, 10, 0, 1], [2, 13, 30, 0], [2, 17, 0, 3],
    [3, 9, 30, 2], [3, 15, 0, 5],
    [4, 10, 0, 0], [4, 17, 0, 3],
    [5, 9, 0, 1], [5, 12, 0, 2],
    [6, 10, 0, 3], [6, 11, 0, 0],
  ]
  for (const [day, hour, minute, pairIdx] of pattern) {
    const pair = pairs[pairIdx]
    const date = inDays(day).set({ hour, minute, second: 0, millisecond: 0 })
    plan.push({
      serviceId: pair.service.id,
      staffId: pair.staff.id,
      customerId: customers[(day * 3 + hour) % customers.length].id,
      startsAt: date.toJSDate(),
      endsAt: date.plus({ minutes: pair.service.durationMin }).toJSDate(),
      priceCents: pair.service.priceCents,
      status: 'CONFIRMED',
      paid: true,
      depositCents: pair.service.depositCents,
    })
  }

  // Two appointments later today, so the overview has something to show even
  // when the demo is opened mid-afternoon. Times are snapped to the next
  // quarter hour *inside* the 09:00-17:00 window.
  const nowLocal = DateTime.now().setZone('America/New_York')
  const todayOffsets: Array<[number, number, number]> = [
    // [hoursFromNow, minutesOffset, index into `pairs`]
    [1, 0, 1],
    [3, 0, 0],
  ]
  for (const [hoursFromNow, , pairIdx] of todayOffsets) {
    const pair = pairs[pairIdx]
    let start = nowLocal.plus({ hours: hoursFromNow }).set({ second: 0, millisecond: 0 })
    if (start.hour < 9) start = start.set({ hour: 9, minute: 0 })
    if (start.hour === 11 || start.hour === 12) start = start.set({ hour: 13, minute: 0 })
    // Snap forward to the next quarter hour so the grid renders cleanly.
    const minute = Math.ceil(start.minute / 15) * 15
    start = minute >= 60 ? start.set({ minute: 0 }).plus({ hours: 1 }) : start.set({ minute })
    const openNow =
      (start.hour >= 9 && start.hour + pair.service.durationMin / 60 <= 12) ||
      (start.hour >= 13 && start.hour + pair.service.durationMin / 60 <= 17)
    if (start.weekday === 7 || !openNow) continue
    plan.push({
      serviceId: pair.service.id,
      staffId: pair.staff.id,
      customerId: customers[(hoursFromNow * 2) % customers.length].id,
      startsAt: start.toJSDate(),
      endsAt: start.plus({ minutes: pair.service.durationMin }).toJSDate(),
      priceCents: pair.service.priceCents,
      status: 'CONFIRMED',
      paid: true,
      depositCents: pair.service.depositCents,
    })
  }

  // One cancelled booking (with refund) and one pending payment to show the
  // unhappy paths in the dashboard.
  const cancelledDate = inDays(3).set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  const pendingDate = inDays(2).set({ hour: 15, minute: 30, second: 0, millisecond: 0 })

  const placed: Array<{ staffId: string; start: number; end: number }> = []
  let created = 0
  // The queued calendar-sync job below needs a real appointment, otherwise it
  // would retry forever and dead-letter on every demo run.
  let firstUpcomingId: string | null = null

  for (const item of plan) {
    const blockStart = item.startsAt.getTime() - 0
    const blockEnd = item.endsAt.getTime() + 15 * 60_000
    if (!isFree(placed, item.staffId, blockStart, blockEnd)) continue
    placed.push({ staffId: item.staffId, start: blockStart, end: blockEnd })

    const zone = 'America/New_York'
    const startLocal = DateTime.fromJSDate(item.startsAt, { zone })
    const endLocal = DateTime.fromJSDate(item.endsAt, { zone })

    const appointment = await prisma.appointment.create({
      data: {
        orgId: org.id,
        locationId: location.id,
        serviceId: item.serviceId,
        staffId: item.staffId,
        customerId: item.customerId,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        blockStartsAt: item.startsAt,
        blockEndsAt: new Date(item.endsAt.getTime() + 15 * 60_000),
        timezone: zone,
        localDate: startLocal.toISODate()!,
        localStartMin: startLocal.hour * 60 + startLocal.minute,
        localEndMin: endLocal.hour * 60 + endLocal.minute,
        status: item.status,
        priceCents: item.priceCents,
        depositCents: item.depositCents,
        amountPaidCents: item.paid ? item.priceCents : 0,
        currency: 'USD',
        createdByType: 'CUSTOMER',
        confirmedAt: item.paid ? item.startsAt : null,
        completedAt: item.status === 'COMPLETED' ? item.endsAt : null,
      },
    })

    if (item.paid) {
      const payment = await prisma.payment.create({
        data: {
          orgId: org.id,
          appointmentId: appointment.id,
          provider: 'mock',
          providerRef: `pi_mock_seed_${appointment.id.slice(0, 12)}`,
          amountCents: item.priceCents,
          currency: 'USD',
          status: 'SUCCEEDED',
          idempotencyKey: `pi_seed_${appointment.id}`,
          capturedAt: item.startsAt,
        },
      })

      if (item.status === 'COMPLETED' && created % 3 === 0) {
        await prisma.notification.create({
          data: {
            orgId: org.id,
            appointmentId: appointment.id,
            channel: 'EMAIL',
            template: 'BOOKING_CONFIRMED',
            recipient: customers[0].email,
            payload: JSON.stringify({ subject: 'Confirmed: your appointment' }),
            status: 'SENT',
            attempts: 1,
            sentAt: item.startsAt,
            dedupeKey: `${appointment.id}:BOOKING_CONFIRMED`,
          },
        })
      }
      void payment
    }

    if (item.status === 'CONFIRMED' && !firstUpcomingId) firstUpcomingId = appointment.id

    if (['CONFIRMED', 'COMPLETED'].includes(item.status)) {
      const ticks = occupancyTicks(appointment.blockStartsAt, appointment.blockEndsAt)
      await prisma.slotLock.createMany({
        data: ticks.map((tickAt) => ({ staffId: item.staffId, tickAt, appointmentId: appointment.id })),
      })
    }
    created++
  }

  // Cancelled + refunded
  const cancelled = await prisma.appointment.create({
    data: {
      orgId: org.id,
      locationId: location.id,
      serviceId: massage.id,
      staffId: jonas.id,
      customerId: customers[1].id,
      startsAt: cancelledDate.toJSDate(),
      endsAt: cancelledDate.plus({ minutes: 45 }).toJSDate(),
      blockStartsAt: cancelledDate.toJSDate(),
      blockEndsAt: cancelledDate.plus({ minutes: 60 }).toJSDate(),
      timezone: 'America/New_York',
      localDate: cancelledDate.toISODate()!,
      localStartMin: cancelledDate.hour * 60,
      localEndMin: cancelledDate.hour * 60 + 45,
      status: 'CANCELLED',
      priceCents: 8500,
      depositCents: 2500,
      amountPaidCents: 0,
      currency: 'USD',
      cancelledAt: DateTime.now().minus({ days: 1 }).toJSDate(),
      cancellationReason: 'Customer rescheduled to next month',
      createdByType: 'CUSTOMER',
    },
  })
  const cancelledPayment = await prisma.payment.create({
    data: {
      orgId: org.id,
      appointmentId: cancelled.id,
      provider: 'mock',
      providerRef: `pi_mock_seed_cancelled`,
      amountCents: 2500,
      currency: 'USD',
      status: 'REFUNDED',
      idempotencyKey: `pi_seed_${cancelled.id}`,
      capturedAt: DateTime.now().minus({ days: 4 }).toJSDate(),
    },
  })
  await prisma.refund.create({
    data: {
      orgId: org.id,
      paymentId: cancelledPayment.id,
      amountCents: 2500,
      reason: 'Cancelled outside policy window',
      status: 'SUCCEEDED',
      providerRef: 're_mock_seed_1',
    },
  })

  // Pending payment (hold active) — the "someone is mid-checkout" state.
  await prisma.appointment.create({
    data: {
      orgId: org.id,
      locationId: location.id,
      serviceId: initial.id,
      staffId: amina.id,
      customerId: customers[7].id,
      startsAt: pendingDate.toJSDate(),
      endsAt: pendingDate.plus({ minutes: 60 }).toJSDate(),
      blockStartsAt: pendingDate.toJSDate(),
      blockEndsAt: pendingDate.plus({ minutes: 75 }).toJSDate(),
      timezone: 'America/New_York',
      localDate: pendingDate.toISODate()!,
      localStartMin: pendingDate.hour * 60 + pendingDate.minute,
      localEndMin: pendingDate.hour * 60 + 30,
      status: 'PENDING_PAYMENT',
      priceCents: 12000,
      depositCents: 4000,
      amountPaidCents: 0,
      currency: 'USD',
      createdByType: 'CUSTOMER',
    },
  })

  // ── integrations & operations ──────────────────────────────────────
  await prisma.externalAccount.create({
    data: {
      orgId: org.id,
      userId: owner.id,
      provider: 'GOOGLE_CALENDAR',
      accessTokenEnc: `demo-access-${randomUUID()}`,
      refreshTokenEnc: `demo-refresh-${randomUUID()}`,
      scope: 'calendar.readwrite',
      expiresAt: DateTime.now().plus({ hours: 1 }).toJSDate(),
    },
  })

  await prisma.job.createMany({
    data: [
      { type: 'notification.send', payload: JSON.stringify({ notificationId: 'seed-history-1' }), status: 'DONE', attempts: 1, orgId: org.id },
      {
        type: 'calendar.sync',
        payload: JSON.stringify({ appointmentId: firstUpcomingId ?? cancelled.id, action: 'upsert' }),
        status: 'QUEUED',
        orgId: org.id,
        runAt: DateTime.now().plus({ minutes: 2 }).toJSDate(),
      },
      { type: 'notification.send', payload: JSON.stringify({ notificationId: 'seed-dead' }), status: 'DEAD_LETTER', attempts: 5, maxAttempts: 5, lastError: 'Transport timeout after 10s', orgId: org.id },
    ],
  })

  await prisma.notification.createMany({
    data: [
      {
        orgId: org.id,
        channel: 'EMAIL',
        template: 'REMINDER_24H',
        recipient: customers[2].email,
        payload: JSON.stringify({ subject: 'Reminder: your appointment tomorrow' }),
        status: 'QUEUED',
        sendAt: DateTime.now().plus({ hours: 6 }).toJSDate(),
        dedupeKey: 'seed-reminder-queued',
      },
      {
        orgId: org.id,
        channel: 'SMS',
        template: 'BOOKING_CONFIRMED',
        recipient: '+1 347 555 0113',
        payload: JSON.stringify({ body: 'Confirmed for tomorrow at 10:00' }),
        status: 'DEAD_LETTER',
        attempts: 5,
        maxAttempts: 5,
        lastError: 'Twilio: unreachable destination',
        dedupeKey: 'seed-sms-dead',
      },
    ],
  })

  await prisma.webhookEvent.create({
    data: {
      provider: 'mock',
      externalId: 'evt_seed_1',
      type: 'payment_intent.succeeded',
      payload: JSON.stringify({ id: 'evt_seed_1', type: 'payment_intent.succeeded' }),
      status: 'PROCESSED',
      orgId: org.id,
      attempts: 1,
      processedAt: DateTime.now().minus({ hours: 3 }).toJSDate(),
    },
  })

  const auditSeeds = [
    ['appointment.created', 'booked Initial Consultation for Grace Lindqvist'],
    ['payment.succeeded', 'payment captured (4000 minor units) — appointment confirmed'],
    ['appointment.rescheduled', 'moved to Mar 14, 14:30'],
    ['appointment.cancelled', 'cancelled Sports Massage'],
    ['slot.held', 'held Follow-up Session at 11:00'],
  ]
  // Staggered timestamps so the activity feed reads like a real day rather than
  // eight events that all happened in the same millisecond.
  for (const [index, [action, summary]] of auditSeeds.entries()) {
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        actorType: index % 3 === 0 ? 'CUSTOMER' : index % 3 === 1 ? 'SYSTEM' : 'USER',
        action,
        entityType: 'Appointment',
        entityId: 'seed',
        metadata: JSON.stringify({ summary }),
        createdAt: DateTime.now().minus({ minutes: 18 * (index + 1) + (index % 2) * 7 }).toJSDate(),
      },
    })
  }

  // ── org B (isolation demo) ─────────────────────────────────────────
  const orgB = await prisma.organization.create({
    data: { name: 'Riverside Barbers', slug: 'riverside', timezone: 'Europe/London', currency: 'GBP' },
  })
  await prisma.membership.create({ data: { orgId: orgB.id, userId: outsider.id, role: 'OWNER' } })
  const locB = await prisma.location.create({
    data: { orgId: orgB.id, name: 'Riverside — Shoreditch', timezone: 'Europe/London', isDefault: true },
  })
  const svcB = await prisma.service.create({
    data: { orgId: orgB.id, name: 'Skin Fade', durationMin: 30, priceCents: 3200, depositCents: 1000 },
  })
  const staffB = await prisma.staff.create({
    data: { orgId: orgB.id, locationId: locB.id, name: 'Riverside Owner', title: 'Barber', color: '#f59e0b' },
  })
  await prisma.staffService.create({ data: { staffId: staffB.id, serviceId: svcB.id } })
  await prisma.workingHours.createMany({
    data: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      staffId: staffB.id,
      locationId: locB.id,
      weekday,
      startMin: 540,
      endMin: 1080,
    })),
  })
  await prisma.customer.create({
    data: { orgId: orgB.id, name: 'Riverside Customer', email: 'customer@riverside.test' },
  })

  const counts = {
    organizations: await prisma.organization.count(),
    staff: await prisma.staff.count(),
    services: await prisma.service.count(),
    appointments: await prisma.appointment.count(),
    slotLocks: await prisma.slotLock.count(),
    notifications: await prisma.notification.count(),
  }
  console.log('Seed complete:', counts)
  console.log(`\nLog in:  owner@northside.test / ${PASSWORD}`)
  console.log(`Staff:   jonas@northside.test / ${PASSWORD}  (member role, reduced permissions)`)
  console.log(`Other tenant: barber@riverside.test / ${PASSWORD}\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
