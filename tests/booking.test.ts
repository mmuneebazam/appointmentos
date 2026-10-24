/**
 * Booking invariants.
 *
 * These are the tests that matter to the business: no double booking under
 * concurrency, holds that expire, retries that do not duplicate, cancellation
 * and reschedule that keep occupancy consistent with reality.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import {
  cancelAppointment,
  createBooking,
  createHold,
  evaluateCancellation,
  expireHold,
  rescheduleAppointment,
} from '@/server/booking'
import { computeAvailability } from '@/server/availability'
import { createFixture, customerPayload, instantAt, nextWeekdayISO, wipeDatabase, type Fixture } from './helpers'

let fx: Fixture
let localDate: string
let startsAt: string

beforeEach(async () => {
  await wipeDatabase()
  fx = await createFixture()
  localDate = nextWeekdayISO(3, 4) // Wednesday, comfortably in the future
  startsAt = instantAt(localDate, 10, 0)
})

describe('availability engine', () => {
  it('offers slots inside working hours and none inside the lunch break', async () => {
    const result = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
    })
    const morning = result.staff.find((s) => s.staffId === fx.staffId)!
    expect(morning.slots.length).toBeGreaterThan(0)
    const labels = morning.slots.map((s) => s.label)
    expect(labels).toContain('09:00')
    // 09:00 + 60min + 15min buffer = ends 10:15, so 10:15 is the next legal start.
    expect(labels).toContain('10:15')
    // Lunch: the last morning consult must end by 12:00 including buffer.
    expect(labels).not.toContain('11:15')
    // Afternoon window resumes at 13:00.
    expect(labels).toContain('13:00')
  })

  it('honours leave by removing the whole day', async () => {
    await prisma.scheduleException.create({
      data: { staffId: fx.staffId, date: localDate, kind: 'LEAVE', note: 'sick' },
    })
    const result = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    expect(result.staff).toHaveLength(0)
    expect(result.reasonIfEmpty).toMatch(/not scheduled/i)
  })

  it('adds extra hours from an exception', async () => {
    const exceptionDate = nextWeekdayISO(6, 4) // Saturday: nobody works
    await prisma.scheduleException.create({
      data: { staffId: fx.staffId, date: exceptionDate, kind: 'EXTRA_HOURS', startMin: 1080, endMin: 1200 },
    })
    const result = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate: exceptionDate,
      staffId: fx.staffId,
    })
    expect(result.staff[0]?.slots.map((s) => s.label)).toContain('18:00')
  })

  it('never offers a slot that a live appointment already occupies', async () => {
    await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })

    const result = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    const labels = result.staff[0].slots.map((s) => s.label)
    expect(labels).not.toContain('10:00')
    // A 10:00 consult runs 10:00–11:00 plus a 15-minute buffer, so nothing may
    // start inside that window — 10:45 would run straight through it.
    expect(labels).not.toContain('10:45')
    expect(labels).not.toContain('11:00')
    // The afternoon window is untouched.
    expect(labels).toContain('13:00')
  })
})

describe('double-booking prevention', () => {
  it('lets exactly one of two racing requests win', async () => {
    const attempt = () =>
      createBooking({
        orgId: fx.orgId,
        serviceId: fx.serviceId,
        staffId: fx.staffId,
        startsAt,
        customer: customerPayload,
        actor: { type: 'CUSTOMER' },
      })

    const results = await Promise.allSettled([attempt(), attempt(), attempt()])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    for (const r of rejected) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/no longer available|just booked/i)
    }

    const count = await prisma.appointment.count({ where: { orgId: fx.orgId } })
    expect(count).toBe(1)
  })

  it('enforces the invariant in the database, not just in application code', async () => {
    // Directly attempt to occupy the same tick twice. This is what protects us
    // if a future code path forgets to call the availability engine.
    const tick = new Date(startsAt)
    await prisma.slotLock.create({ data: { staffId: fx.staffId, tickAt: tick } })
    await expect(
      prisma.slotLock.create({ data: { staffId: fx.staffId, tickAt: tick } }),
    ).rejects.toThrow()
  })

  it('rejects a start time that was never offered', async () => {
    await expect(
      createBooking({
        orgId: fx.orgId,
        serviceId: fx.serviceId,
        staffId: fx.staffId,
        startsAt: instantAt(localDate, 3, 0), // 03:00, outside working hours
        customer: customerPayload,
        actor: { type: 'CUSTOMER' },
      }),
    ).rejects.toThrow(/no longer available/i)
  })

  it('blocks a second overlapping booking that starts at a different time', async () => {
    await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    // A 30-minute follow-up at 10:30 would run inside the 10:00–11:00 consult.
    await expect(
      createBooking({
        orgId: fx.orgId,
        serviceId: fx.followUpServiceId,
        staffId: fx.staffId,
        startsAt: instantAt(localDate, 10, 30),
        customer: { name: 'Other', email: 'other@example.test' },
        actor: { type: 'CUSTOMER' },
      }),
    ).rejects.toThrow()
  })
})

describe('holds', () => {
  it('reserves the slot so a second customer cannot take it, then expires', async () => {
    const hold = await createHold({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
    })

    // While held, the slot is gone from availability…
    const during = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    expect(during.staff.flatMap((s) => s.slots).some((s) => s.label === '10:00')).toBe(false)

    // …and a competing hold is rejected…
    await expect(
      createHold({ orgId: fx.orgId, serviceId: fx.serviceId, staffId: fx.staffId, startsAt }),
    ).rejects.toThrow(/no longer available|just took/i)

    // …but once the hold expires the slot comes back.
    await prisma.slotHold.update({
      where: { token: hold.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const holdRow = await prisma.slotHold.findUniqueOrThrow({ where: { token: hold.token } })
    await expireHold(holdRow.id)

    const after = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    expect(after.staff.flatMap((s) => s.slots).some((s) => s.label === '10:00')).toBe(true)
  })

  it('converts a hold into a confirmed booking without creating duplicate occupancy', async () => {
    const hold = await createHold({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
    })
    const result = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      holdToken: hold.token,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })

    const locks = await prisma.slotLock.findMany({ where: { appointmentId: result.appointment.id } })
    expect(locks.length).toBeGreaterThan(0)
    // 75 minutes of occupancy (60 + 15 buffer) = 5 quarter-hour ticks.
    expect(locks.length).toBe(5)

    const consumed = await prisma.slotHold.findUniqueOrThrow({ where: { token: hold.token } })
    expect(consumed.status).toBe('CONSUMED')
  })
})

describe('idempotency', () => {
  it('returns the same appointment for a repeated idempotency key', async () => {
    const key = 'checkout-attempt-1'
    const first = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      idempotencyKey: key,
      actor: { type: 'CUSTOMER' },
    })
    const second = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      idempotencyKey: key,
      actor: { type: 'CUSTOMER' },
    })

    expect(second.replayed).toBe(true)
    expect(second.appointment.id).toBe(first.appointment.id)
    expect(await prisma.appointment.count({ where: { orgId: fx.orgId } })).toBe(1)
  })
})

describe('cancellation', () => {
  it('refunds in full outside the policy window and frees the slot', async () => {
    const booking = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    // Simulate the payment having succeeded.
    await prisma.appointment.update({
      where: { id: booking.appointment.id },
      data: { status: 'CONFIRMED', amountPaidCents: 4000 },
    })
    const payment = await prisma.payment.findFirst({ where: { appointmentId: booking.appointment.id } })
    if (payment) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } })
    }

    const result = await cancelAppointment({
      orgId: fx.orgId,
      appointmentId: booking.appointment.id,
      reason: 'Plans changed',
      actor: { type: 'CUSTOMER' },
    })

    expect(result.feeCents).toBe(0)
    expect(result.refundCents).toBe(4000)
    expect(await prisma.slotLock.count({ where: { appointmentId: booking.appointment.id } })).toBe(0)

    const availability = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    expect(availability.staff.flatMap((s) => s.slots).some((s) => s.label === '10:00')).toBe(true)
  })

  it('charges a fee inside the window', () => {
    const policy = evaluateCancellation({
      startsAt: new Date(Date.now() + 2 * 3600_000), // 2h away, window is 24h
      now: new Date(),
      windowHours: 24,
      amountPaidCents: 4000,
      priceCents: 12000,
    })
    expect(policy.insideWindow).toBe(true)
    expect(policy.feeCents).toBe(4000)
    expect(policy.refundableCents).toBe(0)
  })

  it('is idempotent — cancelling twice does not refund twice', async () => {
    const booking = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    await prisma.appointment.update({
      where: { id: booking.appointment.id },
      data: { status: 'CONFIRMED', amountPaidCents: 4000 },
    })
    const payment = await prisma.payment.findFirst({ where: { appointmentId: booking.appointment.id } })
    if (payment) await prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } })

    await cancelAppointment({ orgId: fx.orgId, appointmentId: booking.appointment.id, actor: { type: 'CUSTOMER' } })
    const second = await cancelAppointment({
      orgId: fx.orgId,
      appointmentId: booking.appointment.id,
      actor: { type: 'CUSTOMER' },
    })

    expect(second.alreadyCancelled).toBe(true)
    expect(second.refundCents).toBe(0)
    expect(await prisma.refund.count({ where: { orgId: fx.orgId } })).toBe(1)
  })
})

describe('reschedule', () => {
  it('moves the booking and releases the old slot', async () => {
    const booking = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    const newStart = instantAt(localDate, 15, 0)

    await rescheduleAppointment({
      orgId: fx.orgId,
      appointmentId: booking.appointment.id,
      startsAt: newStart,
      actor: { type: 'CUSTOMER' },
    })

    const availability = await computeAvailability(prisma, {
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      localDate,
      staffId: fx.staffId,
    })
    const labels = availability.staff.flatMap((s) => s.slots).map((s) => s.label)
    expect(labels).toContain('10:00') // old slot is free again
    expect(labels).not.toContain('15:00') // new slot is taken
  })

  it('keeps the original appointment when the new slot is taken', async () => {
    const first = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt: instantAt(localDate, 15, 0),
      customer: { name: 'Second', email: 'second@example.test' },
      actor: { type: 'CUSTOMER' },
    })

    await expect(
      rescheduleAppointment({
        orgId: fx.orgId,
        appointmentId: first.appointment.id,
        startsAt: instantAt(localDate, 15, 0),
        actor: { type: 'CUSTOMER' },
      }),
    ).rejects.toThrow()

    const unchanged = await prisma.appointment.findUniqueOrThrow({ where: { id: first.appointment.id } })
    expect(unchanged.startsAt.toISOString()).toBe(new Date(startsAt).toISOString())
    // Still occupying its original slot.
    expect(await prisma.slotLock.count({ where: { appointmentId: first.appointment.id } })).toBe(5)
  })
})

describe('audit trail', () => {
  it('records every lifecycle change', async () => {
    const booking = await createBooking({
      orgId: fx.orgId,
      serviceId: fx.serviceId,
      staffId: fx.staffId,
      startsAt,
      customer: customerPayload,
      actor: { type: 'CUSTOMER' },
    })
    await cancelAppointment({
      orgId: fx.orgId,
      appointmentId: booking.appointment.id,
      reason: 'test',
      actor: { type: 'CUSTOMER' },
    })
    const actions = (
      await prisma.auditLog.findMany({ where: { orgId: fx.orgId }, orderBy: { createdAt: 'asc' } })
    ).map((a) => a.action)
    expect(actions).toContain('appointment.created')
    expect(actions).toContain('appointment.cancelled')
  })
})
