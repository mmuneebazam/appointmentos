/**
 * Tenant isolation.
 *
 * Every organisation-owned read takes orgId and filters on it. These tests prove
 * that knowing another tenant's record id is not enough to read or mutate it —
 * the classic IDOR bug.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { createBooking, cancelAppointment } from '@/server/booking'
import { appointmentDetail, listAppointments, dashboardSummary, customerDirectory } from '@/server/queries'
import { computeAvailability } from '@/server/availability'
import { createFixture, customerPayload, instantAt, nextWeekdayISO, wipeDatabase, type Fixture } from './helpers'

let a: Fixture
let b: Fixture
let appointmentId: string

beforeEach(async () => {
  await wipeDatabase()
  a = await createFixture()
  b = await createFixture()
  const localDate = nextWeekdayISO(3, 4)
  const result = await createBooking({
    orgId: a.orgId,
    serviceId: a.serviceId,
    staffId: a.staffId,
    startsAt: instantAt(localDate, 10, 0),
    customer: customerPayload,
    actor: { type: 'CUSTOMER' },
  })
  appointmentId = result.appointment.id
})

describe('cross-tenant access', () => {
  it('cannot read another tenant appointment by id', async () => {
    expect(await appointmentDetail(a.orgId, appointmentId)).not.toBeNull()
    expect(await appointmentDetail(b.orgId, appointmentId)).toBeNull()
  })

  it('cannot list another tenant appointments', async () => {
    const rows = await listAppointments({ orgId: b.orgId })
    expect(rows.total).toBe(0)
    expect(rows.rows).toHaveLength(0)
  })

  it('cannot cancel another tenant appointment', async () => {
    await expect(
      cancelAppointment({ orgId: b.orgId, appointmentId, actor: { type: 'STAFF' } }),
    ).rejects.toThrow(/not found/i)
    const unchanged = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })
    expect(unchanged.status).toBe('PENDING_PAYMENT')
  })

  it('cannot book into another tenant service', async () => {
    await expect(
      createBooking({
        orgId: b.orgId,
        serviceId: a.serviceId,
        staffId: b.staffId,
        startsAt: instantAt(nextWeekdayISO(3, 4), 10, 0),
        customer: customerPayload,
        actor: { type: 'CUSTOMER' },
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('keeps availability, dashboards and customers scoped', async () => {
    const localDate = nextWeekdayISO(3, 4)
    const availability = await computeAvailability(prisma, {
      orgId: b.orgId,
      serviceId: b.serviceId,
      localDate,
    })
    expect(availability.staff.every((s) => s.staffId === b.staffId || s.staffId === b.otherStaffId)).toBe(true)

    const summary = await dashboardSummary({ orgId: b.orgId, zone: 'America/New_York' })
    expect(summary.todayAppointments).toHaveLength(0)

    const customers = await customerDirectory({ orgId: b.orgId })
    expect(customers.every((c) => c.email !== customerPayload.email)).toBe(true)
  })
})
