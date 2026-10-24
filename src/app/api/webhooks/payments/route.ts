import { prisma } from '@/lib/db'
import { errorResponse, handler } from '@/lib/errors'
import { verifyWebhookSignature, activeWebhookSecret } from '@/server/integrations/payments'
import { ingestWebhook } from '@/server/webhooks'

/**
 * Payment provider webhook.
 *
 * Deliberately thin: verify the signature over the *raw* body, then hand off.
 * No authentication cookie is involved — the signature is the authentication.
 *
 * Always answer 2xx once the event is safely stored, otherwise the provider
 * retries. Processing failures are re-queued internally rather than signalled
 * with a 500, so a transient bug cannot cause an infinite provider retry storm.
 */
export const POST = handler(async (req: Request) => {
  const rawBody = await req.text()
  const header =
    req.headers.get('stripe-signature') ?? req.headers.get('x-aos-signature') ?? null

  const check = verifyWebhookSignature({
    rawBody,
    header,
    secret: activeWebhookSecret(),
  })
  if (!check.valid) {
    console.warn('[webhook] rejected:', check.reason)
    return Response.json(
      { error: { code: 'invalid_signature', message: 'Signature verification failed' } },
      { status: 401 },
    )
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: { code: 'bad_request', message: 'Invalid JSON' } }, { status: 400 })
  }
  if (!event.id || !event.type) {
    return Response.json({ error: { code: 'bad_request', message: 'Missing event id/type' } }, { status: 400 })
  }

  const provider = event.type && event.id.startsWith('evt_') ? (process.env.STRIPE_SECRET_KEY ? 'stripe' : 'mock') : 'mock'
  void prisma

  const outcome = await ingestWebhook({
    provider,
    event: { id: event.id, type: event.type, data: { object: event.data?.object ?? {} } },
    rawBody,
  })

  // 200 for duplicates: telling the provider "already done" is what stops retries.
  return Response.json({ received: true, outcome })
})

export const GET = () => Response.json({ ok: true, hint: 'POST signed events here' })
