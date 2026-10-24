/** Signed, stateless tokens: session cookies and unsubscribe links. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { env } from '@/lib/env'

const secret = new TextEncoder().encode(env.SESSION_SECRET)

export interface SessionClaims {
  userId: string
  email: string
  name: string
}

export async function createSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('appointmentos')
    .setAudience('appointmentos-app')
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'appointmentos',
      audience: 'appointmentos-app',
    })
    if (typeof payload.userId !== 'string') return null
    return {
      userId: payload.userId,
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
    }
  } catch {
    return null
  }
}

function hmac(value: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url')
}

export function signUnsubscribeToken(email: string): string {
  const normalised = email.trim().toLowerCase()
  return `${Buffer.from(normalised).toString('base64url')}.${hmac(normalised)}`
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const email = Buffer.from(encoded, 'base64url').toString('utf8')
  const expected = hmac(email)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return email
}

/**
 * Signed link for the public "manage my booking" page.
 *
 * Without this, anyone could enumerate /book/<org>/appointment/<id> and cancel
 * other people's appointments (a textbook IDOR). The token binds the link to a
 * specific appointment and is only ever emailed to the customer.
 */
export function signAppointmentToken(appointmentId: string, email: string): string {
  const payload = `${appointmentId}:${email.trim().toLowerCase()}`
  return Buffer.from(payload).toString('base64url') + '.' + hmac(payload)
}

export function verifyAppointmentToken(token: string): { appointmentId: string; email: string } | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const payload = Buffer.from(encoded, 'base64url').toString('utf8')
  const expected = hmac(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [appointmentId, email] = payload.split(':')
  if (!appointmentId || !email) return null
  return { appointmentId, email }
}
