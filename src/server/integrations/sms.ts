/** SMS transport, same shape as email: console sink by default, Twilio when configured. */
import { env, features } from '@/lib/env'

export interface SmsMessage {
  to: string
  body: string
}

export interface SmsResult {
  ok: boolean
  provider: string
  providerRef?: string
  error?: string
}

export async function sendSms(message: SmsMessage): Promise<SmsResult> {
  if (!features.twilio) {
    console.info(`[sms:console] to=${message.to} body="${message.body.slice(0, 80)}"`)
    return { ok: true, provider: 'console', providerRef: `console_sms_${Date.now()}` }
  }
  try {
    const body = new URLSearchParams({
      To: message.to,
      From: env.TWILIO_ACCOUNT_SID ? '+15005550006' : '',
      Body: message.body,
    })
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      return { ok: false, provider: 'twilio', error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` }
    }
    const json = (await res.json()) as { sid?: string }
    return { ok: true, provider: 'twilio', providerRef: json.sid }
  } catch (err) {
    return { ok: false, provider: 'twilio', error: err instanceof Error ? err.message : String(err) }
  }
}
