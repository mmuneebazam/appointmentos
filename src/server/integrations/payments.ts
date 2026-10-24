/**
 * Payment provider boundary.
 *
 * The mock provider is not a toy: it produces real payment-intent records, real
 * HMAC-signed webhooks and real idempotency keys, so the entire confirm →
 * webhook → reconcile path is exercised locally. Only the network hop to Stripe
 * differs when STRIPE_SECRET_KEY is present.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { env, features } from '@/lib/env'

export interface PaymentIntentRequest {
  amountCents: number
  currency: string
  appointmentId: string
  customerEmail: string
  description: string
  /** Sent to the provider so a retried request cannot double-charge. */
  idempotencyKey: string
}

export interface PaymentIntent {
  provider: 'mock' | 'stripe'
  providerRef: string
  clientSecret: string
  status: 'REQUIRES_PAYMENT' | 'SUCCEEDED'
}

export async function createPaymentIntent(req: PaymentIntentRequest): Promise<PaymentIntent> {
  if (!features.stripe) {
    const ref = `pi_mock_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    return {
      provider: 'mock',
      providerRef: ref,
      clientSecret: `${ref}_secret_${randomUUID().slice(0, 8)}`,
      status: 'REQUIRES_PAYMENT',
    }
  }

  const body = new URLSearchParams({
    amount: String(req.amountCents), // Stripe also uses minor units
    currency: req.currency.toLowerCase(),
    description: req.description,
    receipt_email: req.customerEmail,
    'metadata[appointmentId]': req.appointmentId,
    'automatic_payment_methods[enabled]': 'true',
  })
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': req.idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Stripe rejected the payment intent: HTTP ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { id: string; client_secret: string; status: string }
  return {
    provider: 'stripe',
    providerRef: json.id,
    clientSecret: json.client_secret,
    status: json.status === 'succeeded' ? 'SUCCEEDED' : 'REQUIRES_PAYMENT',
  }
}

export async function refundPayment(input: {
  provider: 'mock' | 'stripe'
  providerRef: string
  amountCents: number
  idempotencyKey: string
}): Promise<{ ok: boolean; providerRef: string }> {
  if (input.provider === 'mock' || !features.stripe) {
    return { ok: true, providerRef: `re_mock_${randomUUID().slice(0, 20)}` }
  }
  const body = new URLSearchParams({
    payment_intent: input.providerRef,
    amount: String(input.amountCents),
  })
  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': input.idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return { ok: false, providerRef: '' }
  const json = (await res.json()) as { id: string }
  return { ok: true, providerRef: json.id }
}

// ─────────────────────────── webhook signatures ───────────────────────────

export interface SignatureCheck {
  valid: boolean
  reason?: string
}

/**
 * Stripe-style `t=<unix>,v1=<hex hmac>` over `${t}.${rawBody}`.
 * A stale timestamp is rejected so a captured payload cannot be replayed later;
 * the event-id table separately makes replays harmless.
 */
export function verifyWebhookSignature(input: {
  rawBody: string
  header: string | null
  secret: string
  toleranceSeconds?: number
  now?: number
}): SignatureCheck {
  const { rawBody, header, secret } = input
  const tolerance = input.toleranceSeconds ?? 300
  const now = input.now ?? Math.floor(Date.now() / 1000)

  if (!header) return { valid: false, reason: 'missing signature header' }
  const parts = Object.fromEntries(
    header.split(',').map((piece) => {
      const [k, v] = piece.split('=')
      return [k?.trim(), v?.trim()]
    }),
  ) as Record<string, string>

  const timestamp = Number(parts.t)
  const signature = parts.v1
  if (!timestamp || !signature) return { valid: false, reason: 'malformed signature header' }
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: 'timestamp outside tolerance' }

  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch' }
  }
  return { valid: true }
}

/** Build a correctly-signed header — used by the mock checkout and by tests. */
export function signWebhookPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

export function activeWebhookSecret(): string {
  return features.stripe ? env.STRIPE_WEBHOOK_SECRET : env.MOCK_WEBHOOK_SECRET
}
