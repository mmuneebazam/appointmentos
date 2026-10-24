/**
 * Webhook correctness — the money path.
 *
 * A payment provider will deliver events twice, out of order, and after our
 * HTTP request already timed out. These tests pin the behaviour we promise.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { createBooking } from '@/server/booking'
import { ingestWebhook, reprocessWebhookEvent } from '@/server/webhooks'
import { signWebhookPayload, verifyWebhookSignature } from '@/server/integrations/payments'
import { createFixture, customerPayload, instantAt, nextWeekdayISO, wipeDatabase, type Fixture } from './helpers'

const SECRET = 'whsec_test_secret'
let fx: Fixture
let startsAt: string
let localDate: string

beforeEach(async () => {
  await wipeDatabase()
  fx = await createFixture()
  localDate = nextWeekdayISO(3, 4)
  startsAt = instantAt(localDate, 10, 0)
})

async function bookWithPayment() {
  const result = await createBooking({
    orgId: fx.orgId,
    serviceId: fx.serviceId,
    staffId: fx.staffId,
    startsAt,
    customer: customerPayload,
    actor: { type: 'CUSTOMER' },
  })
  const payment = await prisma.payment.findFirstOrThrow({
    where: { appointmentId: result.appointment.id },
  })
  return { appointmentId: result.appointment.id, payment }
}

function succeededEvent(id: string, providerRef: string, amount: number) {
  return {
    id,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: providerRef, amount } },
  }
}

describe('signature verification', () => {
  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ hello: 'world' })
    const header = signWebhookPayload(body, SECRET)
    expect(verifyWebhookSignature({ rawBody: body, header, secret: SECRET }).valid).toBe(true)
  })

  it('rejects a tampered body', () => {
    const header = signWebhookPayload(JSON.stringify({ amount: 100 }), SECRET)
    const result = verifyWebhookSignature({
      rawBody: JSON.stringify({ amount: 100000 }),
      header,
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/mismatch/)
  })

  it('rejects a replayed payload outside the tolerance window', () => {
    const body = JSON.stringify({ id: 'evt_old' })
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600
    const header = signWebhookPayload(body, SECRET, oldTimestamp)
    const result = verifyWebhookSignature({ rawBody: body, header, secret: SECRET })
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/tolerance/)
  })

  it('rejects a missing header', () => {
    expect(verifyWebhookSignature({ rawBody: '{}', header: null, secret: SECRET }).valid).toBe(false)
  })
})

describe('payment success', () => {
  it('confirms the booking and sends exactly one confirmation email', async () => {
    const { appointmentId, payment } = await bookWithPayment()
    const event = succeededEvent('evt_1', payment.providerRef, payment.amountCents)

    const outcome = await ingestWebhook({
      provider: 'mock',
      event,
      rawBody: JSON.stringify(event),
    })
    expect(outcome.status).toBe('processed')

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })
    expect(appointment.status).toBe('CONFIRMED')
    expect(appointment.amountPaidCents).toBe(payment.amountCents)

    const confirmations = await prisma.notification.findMany({
      where: { appointmentId, template: 'BOOKING_CONFIRMED' },
    })
    expect(confirmations).toHaveLength(1)
  })

  it('is idempotent across duplicate deliveries', async () => {
    const { appointmentId, payment } = await bookWithPayment()
    const event = succeededEvent('evt_dup', payment.providerRef, payment.amountCents)

    const first = await ingestWebhook({ provider: 'mock', event, rawBody: JSON.stringify(event) })
    const second = await ingestWebhook({ provider: 'mock', event, rawBody: JSON.stringify(event) })
    const third = await ingestWebhook({ provider: 'mock', event, rawBody: JSON.stringify(event) })

    expect(first.status).toBe('processed')
    expect(second.status).toBe('duplicate')
    expect(third.status).toBe('duplicate')

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })
    // The amount must not be applied three times.
    expect(appointment.amountPaidCents).toBe(payment.amountCents)
    expect(await prisma.notification.count({ where: { appointmentId, template: 'BOOKING_CONFIRMED' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { orgId: fx.orgId, action: 'payment.succeeded' } })).toBe(1)
  })

  it('de-duplicates a replayed event with a different provider id', async () => {
    const { appointmentId, payment } = await bookWithPayment()
    // Providers do sometimes re-issue an event under a new id for the same charge.
    const a = succeededEvent('evt_a', payment.providerRef, payment.amountCents)
    const b = succeededEvent('evt_b', payment.providerRef, payment.amountCents)
    await ingestWebhook({ provider: 'mock', event: a, rawBody: JSON.stringify(a) })
    const second = await ingestWebhook({ provider: 'mock', event: b, rawBody: JSON.stringify(b) })

    expect(second.status).toBe('duplicate')
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })
    expect(appointment.amountPaidCents).toBe(payment.amountCents)
  })
})

describe('out-of-order events', () => {
  it('a late failure event cannot un-succeed a captured payment', async () => {
    const { appointmentId, payment } = await bookWithPayment()
    const success = succeededEvent('evt_ok', payment.providerRef, payment.amountCents)
    await ingestWebhook({ provider: 'mock', event: success, rawBody: JSON.stringify(success) })

    const lateFailure = {
      id: 'evt_late_fail',
      type: 'payment_intent.payment_failed',
      created: Math.floor(Date.now() / 1000) - 60,
      data: { object: { id: payment.providerRef } },
    }
    const outcome = await ingestWebhook({
      provider: 'mock',
      event: lateFailure,
      rawBody: JSON.stringify(lateFailure),
    })

    expect(outcome.status).toBe('skipped')
    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    expect(stored.status).toBe('SUCCEEDED')
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })
    expect(appointment.status).toBe('CONFIRMED')
  })
})

describe('eventual consistency', () => {
  it('defers an event whose payment row is not visible yet, then succeeds on retry', async () => {
    const { payment } = await bookWithPayment()
    const event = succeededEvent('evt_late_arrival', payment.providerRef, payment.amountCents)

    // Simulate the webhook arriving before our own write is visible.
    await prisma.$transaction(async () => {
      /* no-op wrapper to keep the API shape honest */
    })
    const originalStatus = payment.status
    await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: 'pi_not_yet' } })

    const deferred = await ingestWebhook({ provider: 'mock', event, rawBody: JSON.stringify(event) })
    expect(deferred.status).toBe('deferred')

    // The booking row catches up, then the queued retry finishes the job.
    await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: payment.providerRef, status: originalStatus } })
    const row = await prisma.webhookEvent.findFirstOrThrow({ where: { externalId: 'evt_late_arrival' } })
    const retried = await reprocessWebhookEvent(row.id)
    expect(retried.status).toBe('processed')
  })
})
