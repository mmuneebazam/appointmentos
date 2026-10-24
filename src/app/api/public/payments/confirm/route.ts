import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { handler, badRequest, notFound, tooMany } from '@/lib/errors'
import { signWebhookPayload, activeWebhookSecret } from '@/server/integrations/payments'
import { clientIp, rateLimit } from '@/server/ratelimit'

const bodySchema = z.object({
  providerRef: z.string().min(4),
  outcome: z.enum(['succeed', 'fail']).default('succeed'),
  /** Reuse an event id to demonstrate duplicate-delivery handling. */
  eventId: z.string().min(4).optional(),
})

/**
 * Mock checkout.
 *
 * Stands in for the browser-side Stripe confirmation. The point is that it does
 * NOT confirm the booking directly — it emits a signed provider event to the
 * real webhook endpoint, so the demo exercises the same path production uses.
 */
export const POST = handler(async (req: Request) => {
  const limit = rateLimit(`pay:${clientIp(req)}`, 20, 60_000)
  if (!limit.ok) throw tooMany('Too many payment attempts.')

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Invalid payment confirmation', parsed.error.issues)

  const payment = await prisma.payment.findUnique({
    where: { providerRef: parsed.data.providerRef },
    include: { appointment: true },
  })
  if (!payment) throw notFound('Payment not found')

  const event = {
    id: parsed.data.eventId ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type:
      parsed.data.outcome === 'succeed'
        ? 'payment_intent.succeeded'
        : 'payment_intent.payment_failed',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: payment.providerRef, amount: payment.amountCents } },
  }
  const rawBody = JSON.stringify(event)
  const signature = signWebhookPayload(rawBody, activeWebhookSecret())

  // Genuine HTTP round trip through the webhook route (signature verification
  // included). Falls back to in-process ingest if the origin is unreachable.
  const origin = new URL(req.url).origin
  try {
    const forwarded = await fetch(`${origin}/api/webhooks/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: rawBody,
      signal: AbortSignal.timeout(8000),
    })
    const json = await forwarded.json()
    return Response.json({ eventId: event.id, type: event.type, forwarded: true, ...json })
  } catch (err) {
    console.warn('[mock-checkout] direct webhook call failed, failing over', err)
    const { ingestWebhook } = await import('@/server/webhooks')
    const outcome = await ingestWebhook({ provider: 'mock', event, rawBody })
    return Response.json({ eventId: event.id, type: event.type, forwarded: false, outcome })
  }
})
