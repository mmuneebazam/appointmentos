/**
 * Notification orchestration.
 *
 * Two invariants:
 *   1. A booking change enqueues a *notification row* with a deterministic
 *      dedupeKey (`<appointmentId>:<template>:<version>`). Inserting that row
 *      twice is a no-op, so a retried job or a replayed webhook cannot email the
 *      customer twice.
 *   2. Delivery happens in the queue, never inline with the booking request, so
 *      a slow mail provider cannot fail a booking.
 */
import { prisma, type Tx } from '@/lib/db'
import { formatDateTime } from '@/lib/time'
import { formatMoney } from '@/lib/money'
import { enqueue } from './jobs'
import { sendEmail } from './integrations/email'
import { sendSms } from './integrations/sms'
import { signUnsubscribeToken } from './tokens'

export type Template =
  | 'BOOKING_RECEIVED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_RESCHEDULED'
  | 'REMINDER_24H'
  | 'PAYMENT_FAILED'
  | 'STAFF_ALERT'
  | 'WAITLIST_OPENING'

export interface NotificationContext {
  appointmentId: string
  orgName: string
  orgSlug: string
  customerName: string
  customerEmail: string
  customerPhone?: string | null
  staffName: string
  serviceName: string
  locationName: string
  startsAt: Date
  endsAt: Date
  timezone: string
  priceCents: number
  currency: string
  appUrl: string
  /** Bumping this (e.g. on reschedule) makes a new reminder legal again. */
  version?: string
}

interface RenderedTemplate {
  subject: string
  html: string
  text: string
  sms?: string
}

export function renderTemplate(template: Template, ctx: NotificationContext): RenderedTemplate {
  const when = formatDateTime(ctx.startsAt, ctx.timezone)
  const price = formatMoney(ctx.priceCents, ctx.currency)
  const manageUrl = `${ctx.appUrl}/book/${ctx.orgSlug}/appointment/${ctx.appointmentId}`
  const unsub = `${ctx.appUrl}/api/public/unsubscribe?token=${signUnsubscribeToken(ctx.customerEmail)}`

  const shell = (heading: string, body: string) => `<!doctype html>
<html><body style="margin:0;background:#f6f7fb;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
    <table width="100%" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e7e8ef">
      <tr><td style="padding:20px 24px;background:#111827;color:#fff;font-weight:600;font-size:15px">${ctx.orgName}</td></tr>
      <tr><td style="padding:24px">
        <h1 style="margin:0 0 12px;font-size:20px;color:#111827">${heading}</h1>
        ${body}
        <p style="margin:24px 0 0"><a href="${manageUrl}" style="background:#4f46e5;color:#fff;padding:11px 18px;border-radius:9px;text-decoration:none;font-size:14px;display:inline-block">Manage booking</a></p>
      </td></tr>
      <tr><td style="padding:16px 24px;color:#6b7280;font-size:12px;border-top:1px solid #eef0f5">
        ${ctx.serviceName} · ${ctx.staffName} · ${when}<br/>
        <a href="${unsub}" style="color:#9ca3af">Unsubscribe from emails</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`

  const details = `<p style="margin:0;color:#374151;font-size:14px;line-height:1.6">
    <strong>${ctx.serviceName}</strong> with ${ctx.staffName}<br/>
    ${when} (${ctx.timezone})<br/>
    ${ctx.locationName}<br/>
    ${price}
  </p>`

  switch (template) {
    case 'BOOKING_RECEIVED':
      return {
        subject: `Complete your payment — ${ctx.serviceName} on ${when}`,
        html: shell('One step left', `<p style="color:#374151;font-size:14px">We're holding your slot, but it is not confirmed until payment is received.</p>${details}`),
        text: `We're holding your slot for ${ctx.serviceName} on ${when}. It is not confirmed until payment is received. Manage: ${manageUrl}`,
        sms: `${ctx.orgName}: slot held for ${when}. Complete payment to confirm.`,
      }
    case 'BOOKING_CONFIRMED':
      return {
        subject: `Confirmed: ${ctx.serviceName} on ${when}`,
        html: shell('You’re booked', `<p style="color:#374151;font-size:14px">Your appointment is confirmed. We'll send a reminder the day before.</p>${details}`),
        text: `Your appointment is confirmed: ${ctx.serviceName} with ${ctx.staffName} on ${when}. Manage: ${manageUrl}`,
        sms: `${ctx.orgName}: confirmed for ${when}. Reply STOP to opt out.`,
      }
    case 'BOOKING_CANCELLED':
      return {
        subject: `Cancelled: ${ctx.serviceName} on ${when}`,
        html: shell('Booking cancelled', `<p style="color:#374151;font-size:14px">This appointment has been cancelled. If a refund applies it will appear on your statement within 5–10 business days.</p>${details}`),
        text: `Your appointment on ${when} has been cancelled.`,
        sms: `${ctx.orgName}: your ${when} appointment was cancelled.`,
      }
    case 'BOOKING_RESCHEDULED':
      return {
        subject: `Moved: ${ctx.serviceName} is now ${when}`,
        html: shell('Your appointment moved', `<p style="color:#374151;font-size:14px">Here are the new details.</p>${details}`),
        text: `Your appointment moved to ${when}. Manage: ${manageUrl}`,
        sms: `${ctx.orgName}: appointment moved to ${when}.`,
      }
    case 'REMINDER_24H':
      return {
        subject: `Reminder: ${ctx.serviceName} tomorrow`,
        html: shell('See you tomorrow', `<p style="color:#374151;font-size:14px">A quick reminder about your upcoming appointment.</p>${details}`),
        text: `Reminder: ${ctx.serviceName} with ${ctx.staffName} on ${when}.`,
        sms: `${ctx.orgName}: reminder — ${when}.`,
      }
    case 'PAYMENT_FAILED':
      return {
        subject: `Payment failed — ${ctx.serviceName}`,
        html: shell('Payment did not go through', `<p style="color:#374151;font-size:14px">Your card was declined and the slot will be released soon. You can retry from the link below.</p>${details}`),
        text: `Your payment failed for ${ctx.serviceName} on ${when}. Retry: ${manageUrl}`,
      }
    case 'STAFF_ALERT':
      return {
        subject: `New booking: ${ctx.customerName} — ${ctx.serviceName}`,
        html: shell('New booking', `<p style="color:#374151;font-size:14px">${ctx.customerName} booked ${ctx.serviceName}.</p>${details}`),
        text: `New booking: ${ctx.customerName} — ${ctx.serviceName} on ${when}`,
      }
    case 'WAITLIST_OPENING':
      return {
        subject: `A slot opened up — ${ctx.serviceName}`,
        html: shell('A slot opened up', `<p style="color:#374151;font-size:14px">Someone cancelled. This slot is first-come, first-served.</p>${details}`),
        text: `A slot opened for ${ctx.serviceName} on ${when}. Book: ${manageUrl}`,
      }
  }
}

/**
 * Queue a notification. Returns null when the dedupeKey already exists, which is
 * the normal (and correct) outcome for duplicate webhooks and job retries.
 */
export async function queueNotification(
  db: Tx | typeof prisma,
  input: {
    orgId: string
    appointmentId?: string | null
    channel: 'EMAIL' | 'SMS'
    template: Template
    recipient: string
    ctx: NotificationContext
    sendAt?: Date
    dedupeKey: string
  },
): Promise<string | null> {
  const rendered = renderTemplate(input.template, input.ctx)
  const existing = await db.notification.findUnique({ where: { dedupeKey: input.dedupeKey } })
  if (existing) return null

  const notification = await db.notification.create({
    data: {
      orgId: input.orgId,
      appointmentId: input.appointmentId ?? null,
      channel: input.channel,
      template: input.template,
      recipient: input.recipient,
      payload: JSON.stringify({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        body: rendered.sms ?? rendered.text,
      }),
      sendAt: input.sendAt ?? new Date(),
      dedupeKey: input.dedupeKey,
    },
  })

  await enqueue(
    'notification.send',
    { notificationId: notification.id },
    { runAt: input.sendAt ?? new Date(), orgId: input.orgId },
    db,
  )
  return notification.id
}

/** Worker handler. Idempotent: re-running a SENT notification is a no-op. */
export async function deliverNotification(notificationId: string): Promise<void> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } })
  if (!notification) throw new Error(`Notification ${notificationId} not found`)
  if (notification.status === 'SENT') return

  if (notification.attempts >= notification.maxAttempts) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: 'DEAD_LETTER' },
    })
    return
  }

  // Respect a cancellation that happened after the reminder was scheduled.
  if (notification.appointmentId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: notification.appointmentId },
      select: { status: true },
    })
    if (
      appointment &&
      ['CANCELLED', 'NO_SHOW'].includes(appointment.status) &&
      notification.template !== 'BOOKING_CANCELLED'
    ) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'FAILED', lastError: 'Appointment no longer active — suppressed' },
      })
      return
    }
  }

  const payload = JSON.parse(notification.payload) as {
    subject?: string
    html?: string
    text?: string
    body?: string
  }

  const result =
    notification.channel === 'EMAIL'
      ? await sendEmail({
          to: notification.recipient,
          subject: payload.subject ?? 'Appointment update',
          html: payload.html ?? '',
          text: payload.text ?? '',
          idempotencyKey: notification.dedupeKey,
        })
      : await sendSms({ to: notification.recipient, body: payload.body ?? payload.text ?? '' })

  if (result.ok) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
    })
    return
  }

  const attempts = notification.attempts + 1
  const exhausted = attempts >= notification.maxAttempts
  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      attempts,
      status: exhausted ? 'DEAD_LETTER' : 'QUEUED',
      lastError: result.error?.slice(0, 500) ?? 'Unknown transport error',
    },
  })
  // Throw so the job layer applies backoff and records the attempt.
  throw new Error(result.error ?? 'Transport failure')
}
