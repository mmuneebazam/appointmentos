/**
 * Runtime configuration.
 *
 * Everything is read once, validated once, and fails loudly at boot rather than
 * halfway through a payment webhook. Optional integrations stay optional: when a
 * key is absent the corresponding adapter falls back to a local simulator so the
 * whole product remains demoable without third-party accounts.
 */
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(24, 'SESSION_SECRET must be at least 24 chars'),
  APP_URL: z.string().default('http://localhost:3000'),

  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  MOCK_WEBHOOK_SECRET: z.string().optional().default('whsec_mock_dev_secret'),

  NOTIFY_TRANSPORT: z.enum(['console', 'resend', 'twilio']).default('console'),
  RESEND_API_KEY: z.string().optional().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),

  CALENDAR_PROVIDER: z.enum(['fake', 'google', 'microsoft']).default('fake'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  MS_CLIENT_ID: z.string().optional().default(''),
  MS_CLIENT_SECRET: z.string().optional().default(''),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const env = parsed.data

export const isProd = env.NODE_ENV === 'production'
export const features = {
  stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  resend: env.NOTIFY_TRANSPORT === 'resend' && Boolean(env.RESEND_API_KEY),
  twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
  googleCalendar: env.CALENDAR_PROVIDER === 'google' && Boolean(env.GOOGLE_CLIENT_ID),
  microsoftCalendar: env.CALENDAR_PROVIDER === 'microsoft' && Boolean(env.MS_CLIENT_ID),
}
