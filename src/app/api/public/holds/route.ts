import { z } from 'zod'
import { prisma } from '@/lib/db'
import { handler, badRequest, tooMany, notFound } from '@/lib/errors'
import { createHold } from '@/server/booking'
import { clientIp, rateLimit } from '@/server/ratelimit'

const bodySchema = z.object({
  orgSlug: z.string().min(1),
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  startsAt: z.string().datetime(),
})

/**
 * Reserve a slot while the customer fills in details. Rate limited hard: holds
 * are the cheapest way to deny service to everyone else if left unguarded.
 */
export const POST = handler(async (req: Request) => {
  const limit = rateLimit(`hold:${clientIp(req)}`, 8, 60_000)
  if (!limit.ok) throw tooMany('Too many holds from this address. Try again in a minute.')

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Invalid hold request', parsed.error.issues)

  const org = await prisma.organization.findUnique({ where: { slug: parsed.data.orgSlug } })
  if (!org) throw notFound('Unknown organization')

  const hold = await createHold({
    orgId: org.id,
    serviceId: parsed.data.serviceId,
    staffId: parsed.data.staffId,
    startsAt: parsed.data.startsAt,
  })
  return Response.json(hold, { status: 201 })
})
