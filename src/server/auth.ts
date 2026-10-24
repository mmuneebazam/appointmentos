/**
 * Authentication + authorisation.
 *
 * Two separate concerns, deliberately:
 *   • Authentication — who is calling? A signed JWT in an httpOnly cookie.
 *   • Authorisation — may they touch *this organisation's* record? Every
 *     org-scoped query goes through `requireMembership`, so tenant isolation is
 *     enforced in one place instead of being remembered at each call site.
 */
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { forbidden, unauthorized } from '@/lib/errors'
import type { Role } from '@/lib/domain'
import { canManage } from '@/lib/domain'
import { createSessionToken, verifySessionToken } from './tokens'

export const SESSION_COOKIE = 'aos_session'

export async function hashPassword(plain: string): Promise<string> {
  // cost 10 keeps the seed fast while staying above the OWASP floor for
  // interactive login; production should tune to ~250ms on target hardware.
  return bcrypt.hash(plain, 10)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
  // Constant-ish work whether or not the user exists, to blunt user enumeration.
  const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva'
  const ok = await verifyPassword(password, hash)
  if (!user || !ok) throw unauthorized('Email or password is incorrect')

  const token = await createSessionToken({ userId: user.id, email: user.email, name: user.name })
  await setSessionCookie(token)
  return user
}

export async function currentUser() {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  const claims = await verifySessionToken(token)
  if (!claims) return null
  return prisma.user.findUnique({ where: { id: claims.userId } })
}

export interface TenantContext {
  user: { id: string; name: string; email: string; timezone: string }
  org: {
    id: string
    name: string
    slug: string
    timezone: string
    currency: string
    depositRequired: boolean
    cancellationWindowHrs: number
    slotHoldMinutes: number
    brandColor: string
  }
  role: Role
}

/**
 * The single gate for tenant-scoped dashboard work. Throws 401/403 rather than
 * returning null so a forgotten check cannot silently become an open door.
 */
export async function requireMembership(orgSlug?: string): Promise<TenantContext> {
  const user = await currentUser()
  if (!user) throw unauthorized()

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id, ...(orgSlug ? { org: { slug: orgSlug } } : {}) },
    include: { org: true },
    orderBy: { orgId: 'asc' },
  })
  if (memberships.length === 0) throw forbidden('You do not have access to this workspace')

  const membership = memberships[0]
  return {
    user: { id: user.id, name: user.name, email: user.email, timezone: user.timezone },
    org: membership.org,
    role: membership.role as Role,
  }
}

export function requireManager(ctx: TenantContext): void {
  if (!canManage(ctx.role)) throw forbidden('Only owners and admins can do that')
}
