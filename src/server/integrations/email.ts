/**
 * Email transport.
 *
 * `console` is a deliberate no-op sink for local dev and tests: it records what
 * *would* have been sent so the notification log is still meaningful, but never
 * touches the network. Swapping NOTIFY_TRANSPORT=resend activates the live path
 * with the same interface.
 */
import { env, features } from '@/lib/env'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Provider-side dedupe where supported (Resend supports Idempotency-Key). */
  idempotencyKey?: string
}

export interface SendResult {
  ok: boolean
  provider: string
  providerRef?: string
  error?: string
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (!features.resend) {
    console.info(
      `[email:console] to=${message.to} subject="${message.subject}" idem=${message.idempotencyKey ?? '-'}`,
    )
    return { ok: true, provider: 'console', providerRef: `console_${Date.now()}` }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: 'AppointmentOS <bookings@example.com>',
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, provider: 'resend', error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    const json = (await res.json()) as { id?: string }
    return { ok: true, provider: 'resend', providerRef: json.id }
  } catch (err) {
    // Timeouts and 5xx are retryable — surface them so the worker backs off.
    return { ok: false, provider: 'resend', error: err instanceof Error ? err.message : String(err) }
  }
}
