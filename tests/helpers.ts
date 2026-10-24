/**
 * Test fixtures.
 *
 * A tiny, controlled world: one org, one location, one service, one staff
 * member working 09:00–17:00 on weekdays. Anything the availability engine
 * returns can then be reasoned about by hand.
 */
import { prisma } from '@/lib/db'
import { DateTime } from 'luxon'

export const ZONE = 'America/New_York'

export async function wipeDatabase() {
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

export interface Fixture {
  orgId: string
  orgSlug: string
  locationId: string
  serviceId: string
  followUpServiceId: string
  staffId: string
  otherStaffId: string
}

export async function createFixture(overrides?: {
  depositRequired?: boolean
  depositCents?: number
  priceCents?: number
  cancellationWindowHrs?: number
}): Promise<Fixture> {
  const org = await prisma.organization.create({
    data: {
      name: 'Test Clinic',
      slug: `test-${Math.random().toString(36).slice(2, 8)}`,
      timezone: ZONE,
      currency: 'USD',
      depositRequired: overrides?.depositRequired ?? true,
      cancellationWindowHrs: overrides?.cancellationWindowHrs ?? 24,
      slotHoldMinutes: 10,
    },
  })
  const location = await prisma.location.create({
    data: { orgId: org.id, name: 'Main', timezone: ZONE, isDefault: true },
  })
  const service = await prisma.service.create({
    data: {
      orgId: org.id,
      name: 'Consultation',
      durationMin: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 15,
      priceCents: overrides?.priceCents ?? 12000,
      depositCents: overrides?.depositCents ?? 4000,
    },
  })
  const followUp = await prisma.service.create({
    data: {
      orgId: org.id,
      name: 'Follow-up',
      durationMin: 30,
      bufferAfterMin: 0,
      priceCents: 6000,
      depositCents: 2000,
    },
  })
  const staff = await prisma.staff.create({
    data: { orgId: org.id, locationId: location.id, name: 'Dr Test', email: 'dr@test.local', color: '#111' },
  })
  const otherStaff = await prisma.staff.create({
    data: { orgId: org.id, locationId: location.id, name: 'Dr Other', email: 'other@test.local', color: '#222' },
  })
  await prisma.staffService.createMany({
    data: [
      { staffId: staff.id, serviceId: service.id },
      { staffId: staff.id, serviceId: followUp.id },
      { staffId: otherStaff.id, serviceId: service.id },
      { staffId: otherStaff.id, serviceId: followUp.id },
    ],
  })
  // Weekdays 09:00–17:00 with a 12:00–13:00 lunch gap.
  const hours: Array<{ weekday: number; startMin: number; endMin: number }> = []
  for (const weekday of [1, 2, 3, 4, 5]) {
    hours.push({ weekday, startMin: 540, endMin: 720 })
    hours.push({ weekday, startMin: 780, endMin: 1020 })
  }
  for (const s of [staff, otherStaff]) {
    await prisma.workingHours.createMany({
      data: hours.map((h) => ({ ...h, staffId: s.id, locationId: location.id })),
    })
  }

  return {
    orgId: org.id,
    orgSlug: org.slug,
    locationId: location.id,
    serviceId: service.id,
    followUpServiceId: followUp.id,
    staffId: staff.id,
    otherStaffId: otherStaff.id,
  }
}

/** Next occurrence of a weekday (1=Mon … 5=Fri) at least `minDaysAhead` out. */
export function nextWeekdayISO(weekday: number, minDaysAhead = 3, from = DateTime.now().setZone(ZONE)): string {
  let cursor = from.plus({ days: minDaysAhead }).startOf('day')
  let guard = 0
  while (cursor.weekday !== weekday && guard++ < 14) cursor = cursor.plus({ days: 1 })
  return cursor.toISODate()!
}

/** ISO instant for a local wall-clock time on a local date. */
export function instantAt(localDate: string, hour: number, minute = 0): string {
  return DateTime.fromISO(localDate, { zone: ZONE })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

export const customerPayload = {
  name: 'Grace Lindqvist',
  email: 'grace@example.test',
  phone: '+13475550110',
}

export { prisma }
