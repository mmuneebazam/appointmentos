/**
 * Inbound payment webhooks.
 *
 * Money is authoritative at the provider, so a webhook can arrive:
 *   • twice (provider retry)              → event table makes the second a no-op
 *   • late, after the HTTP request failed → still confirms the booking
 *   • out of order (failed then succeeded)→ status only moves forward
 *   • with no matching local record yet   → durably re-queued, not dropped
 *
 * Every handler is written as "apply if not already applied", keyed on the
 * provider's idempotency surface, never on our own request lifecycle.
 */
import { prisma, type Tx } from '@/lib/db'
import { recordAudit } from './audit'
import { queueNotification } from './notifications'
import { enqueue } from './jobs'
import { formatDateTime } from '@/lib/time'
import type { NotificationContext } from './notifications'

export interface ProviderEvent {
  id: string
  type: string
  created?: number
  data: { object: Record<string, unknown> }
}

export interface WebhookOutcome {
  status: 'processed' | 'duplicate' | 'skipped' | 'deferred' | 'failed'
  detail?: string
}

function asContext(
  org: { name: string; slug: string },
  appointment: {
    id: string
    startsAt: Date
    endsAt: Date
    priceCents: number
    currency: string
    timezone: string
  },
  serviceName: string,
  staffName: string,
  locationName: string,
  customer: { name: string; email: string; phone: string | null },
): NotificationContext {
  return {
    appointmentId: appointment.id,
    orgName: org.name,
    orgSlug: org.slug,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    staffName,
    serviceName,
    locationName,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timezone: appointment.timezone,
    priceCents: appointment.priceCents,
    currency: appointment.currency,
    appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  }
}

/**
 * Record the event exactly once, then dispatch.
 * Returns `duplicate` for a repeat delivery of an event we already finished.
 */
export async function ingestWebhook(input: {
  provider: string
  event: ProviderEvent
  rawBody: string
}): Promise<WebhookOutcome> {
  const { provider, event } = input

  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_externalId: { provider, externalId: event.id } },
  })

  if (existing) {
    if (existing.status === 'PROCESSED' || existing.status === 'SKIPPED') {
      // The provider retried. Acknowledge with 200 so it stops retrying, and
      // change nothing. This is what makes duplicate webhooks harmless.
      return { status: 'duplicate', detail: `event ${event.id} already ${existing.status}` }
    }
    if (existing.status === 'RECEIVED' && existing.attempts > 0) {
      // A previous attempt crashed part-way; finish the work.
      return dispatchEvent(provider, event, existing.id)
    }
  }

  let eventRowId: string
  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider,
        externalId: event.id,
        type: event.type,
        payload: input.rawBody.slice(0, 20_000),
        attempts: 1,
      },
    })
    eventRowId = created.id
  } catch (err) {
    if (String(err).includes('P2002') || String(err).includes('Unique constraint')) {
      return { status: 'duplicate', detail: 'concurrent delivery of the same event' }
    }
    throw err
  }

  return dispatchEvent(provider, event, eventRowId)
}

async function dispatchEvent(
  provider: string,
  event: ProviderEvent,
  eventRowId: string,
): Promise<WebhookOutcome> {
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        return await handlePaymentSucceeded(event, eventRowId)
      case 'payment_intent.payment_failed':
        return await handlePaymentFailed(event, eventRowId)
      case 'charge.refunded':
        return await markEvent(eventRowId, 'SKIPPED', 'refunds are driven by our own job')
      default:
        return await markEvent(eventRowId, 'SKIPPED', `unhandled type ${event.type}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'FAILED', error: message.slice(0, 500), attempts: { increment: 1 } },
    })
    // Re-queue with backoff instead of asking the provider to hammer us.
    await enqueue('webhook.process', { eventRowId }, { maxAttempts: 8 })
    console.error('[webhook] processing failed, re-queued', message)
    return { status: 'failed', detail: message }
  }
}

async function markEvent(id: string, status: string, detail?: string): Promise<WebhookOutcome> {
  await prisma.webhookEvent.update({
    where: { id },
    data: {
      status,
      processedAt: new Date(),
      error: detail ?? null,
      orgId: (await prisma.webhookEvent.findUnique({ where: { id } }))?.orgId ?? null,
    },
  })
  return { status: status === 'SKIPPED' ? 'skipped' : 'processed', detail }
}

async function handlePaymentSucceeded(
  event: ProviderEvent,
  eventRowId: string,
): Promise<WebhookOutcome> {
  const object = event.data.object
  const providerRef = String(object.id ?? '')
  const amount = Number(object.amount ?? 0)

  const payment = await prisma.payment.findUnique({ where: { providerRef } })
  if (!payment) {
    // Normal when the webhook beats the booking response. Keep the event and
    // let the queue retry rather than dropping money on the floor.
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'RECEIVED', error: 'payment not found yet' },
    })
    await enqueue('webhook.process', { eventRowId }, { runAt: new Date(Date.now() + 3_000) })
    return { status: 'deferred', detail: 'payment record not yet visible' }
  }

  // Monotonic: a stale failure must never un-succeed a payment, and a repeated
  // success must not add the amount twice.
  if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED') {
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'SKIPPED', processedAt: new Date(), orgId: payment.orgId, error: 'already applied' },
    })
    return { status: 'duplicate', detail: 'payment already succeeded' }
  }

  await prisma.$transaction(async (tx: Tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', capturedAt: new Date() },
    })

    const appointment = await tx.appointment.findUniqueOrThrow({
      where: { id: payment.appointmentId },
      include: {
        service: true,
        staff: true,
        customer: true,
        org: true,
        location: true,
      },
    })

    const newPaid = Math.min(
      appointment.amountPaidCents + (amount || payment.amountCents),
      appointment.priceCents,
    )
    const shouldConfirm = appointment.status === 'PENDING_PAYMENT'

    await tx.appointment.update({
      where: { id: appointment.id },
      data: {
        amountPaidCents: newPaid,
        status: shouldConfirm ? 'CONFIRMED' : appointment.status,
        confirmedAt: shouldConfirm ? new Date() : appointment.confirmedAt,
      },
    })

    await tx.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'PROCESSED', processedAt: new Date(), orgId: payment.orgId, attempts: { increment: 1 } },
    })

    await recordAudit(
      {
        orgId: payment.orgId,
        actorType: 'WEBHOOK',
        action: 'payment.succeeded',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: {
          summary: `payment captured (${payment.amountCents} minor units) — appointment ${shouldConfirm ? 'confirmed' : 'updated'}`,
          eventId: event.id,
          amountCents: payment.amountCents,
        },
      },
      tx,
    )

    if (shouldConfirm) {
      const ctx = asContext(
        appointment.org,
        appointment,
        appointment.service.name,
        appointment.staff.name,
        appointment.location.name,
        appointment.customer,
      )
      // dedupeKey makes this the *only* confirmation email for this booking,
      // even if the provider delivers the success event three times.
      await queueNotification(tx, {
        orgId: payment.orgId,
        appointmentId: appointment.id,
        channel: 'EMAIL',
        template: 'BOOKING_CONFIRMED',
        recipient: appointment.customer.email,
        ctx,
        dedupeKey: `${appointment.id}:BOOKING_CONFIRMED`,
      })
      const reminderAt = new Date(appointment.startsAt.getTime() - 24 * 3600_000)
      if (reminderAt > new Date()) {
        await queueNotification(tx, {
          orgId: payment.orgId,
          appointmentId: appointment.id,
          channel: 'EMAIL',
          template: 'REMINDER_24H',
          recipient: appointment.customer.email,
          ctx,
          sendAt: reminderAt,
          dedupeKey: `${appointment.id}:REMINDER_24H:v1`,
        })
      }
      await enqueue('calendar.sync', { appointmentId: appointment.id, action: 'upsert' }, { orgId: payment.orgId }, tx)
    }
  })

  return { status: 'processed' }
}

async function handlePaymentFailed(
  event: ProviderEvent,
  eventRowId: string,
): Promise<WebhookOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { providerRef: String(event.data.object.id ?? '') },
  })
  if (!payment) {
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'RECEIVED', error: 'payment not found yet' },
    })
    await enqueue('webhook.process', { eventRowId }, { runAt: new Date(Date.now() + 3_000) })
    return { status: 'deferred' }
  }

  // Out-of-order guard: a late "failed" event must not overwrite a success.
  if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED') {
    await prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: {
        status: 'SKIPPED',
        processedAt: new Date(),
        orgId: payment.orgId,
        error: 'stale failure event ignored — payment already succeeded',
      },
    })
    return { status: 'skipped', detail: 'stale failure ignored' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedAt: new Date() } })
    await tx.webhookEvent.update({
      where: { id: eventRowId },
      data: { status: 'PROCESSED', processedAt: new Date(), orgId: payment.orgId, attempts: { increment: 1 } },
    })
    const appointment = await tx.appointment.findUniqueOrThrow({
      where: { id: payment.appointmentId },
      include: { service: true, staff: true, customer: true, org: true, location: true },
    })
    await recordAudit(
      {
        orgId: payment.orgId,
        actorType: 'WEBHOOK',
        action: 'payment.failed',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: { summary: 'payment declined by provider', eventId: event.id },
      },
      tx,
    )
    await queueNotification(tx, {
      orgId: payment.orgId,
      appointmentId: appointment.id,
      channel: 'EMAIL',
      template: 'PAYMENT_FAILED',
      recipient: appointment.customer.email,
      ctx: asContext(
        appointment.org,
        appointment,
        appointment.service.name,
        appointment.staff.name,
        appointment.location.name,
        appointment.customer,
      ),
      dedupeKey: `${appointment.id}:PAYMENT_FAILED:${payment.id}`,
    })
  })

  return { status: 'processed' }
}

/** Retry entry point used by the worker for `webhook.process` jobs. */
export async function reprocessWebhookEvent(eventRowId: string): Promise<WebhookOutcome> {
  const row = await prisma.webhookEvent.findUnique({ where: { id: eventRowId } })
  if (!row) throw new Error('Webhook event not found')
  if (row.status === 'PROCESSED' || row.status === 'SKIPPED') return { status: 'duplicate' }
  const event = JSON.parse(row.payload) as ProviderEvent
  return dispatchEvent(row.provider, event, row.id)
}

/** Used by the mock checkout screen to describe what happened, human-readably. */
export function describeOutcome(outcome: WebhookOutcome): string {
  switch (outcome.status) {
    case 'processed':
      return 'Payment applied and booking confirmed.'
    case 'duplicate':
      return 'Already handled — this event was a duplicate, so nothing changed.'
    case 'skipped':
      return 'Ignored — the event was stale or unhandled.'
    case 'deferred':
      return 'Accepted, but the booking record is not visible yet; it will retry.'
    case 'failed':
      return 'Stored for retry — processing will be attempted again.'
  }
}

export function formatEventTime(created?: number): string {
  return created ? formatDateTime(new Date(created * 1000), 'UTC') : '—'
}
