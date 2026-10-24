import { z } from 'zod'
import { prisma } from '@/lib/db'
import { handler, badRequest, tooMany, notFound } from '@/lib/errors'
import { computeAvailability, availabilitySummary } from '@/server/availability'
import { clientIp, rateLimit } from '@/server/ratelimit'

const querySchema = z.object({
  org: z.string().min(1),
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staffId: z.string().optional(),
  mode: z.enum(['day', 'week']).default('day'),
  days: z.coerce.number().int().min(1).max(21).default(14),
})

export const GET = handler(async (req: Request) => {
  const limit = rateLimit(`availability:${clientIp(req)}`, 120, 60_000)
  if (!limit.ok) throw tooMany('Slow down for a moment and try again.')

  const url = new URL(req.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) throw badRequest('Invalid availability query', parsed.error.issues)

  const org = await prisma.organization.findUnique({ where: { slug: parsed.data.org } })
  if (!org) throw notFound('Unknown organization')

  if (parsed.data.mode === 'week') {
    const summary = await availabilitySummary(prisma, {
      orgId: org.id,
      serviceId: parsed.data.serviceId,
      fromDate: parsed.data.date,
      days: parsed.data.days,
    })
    return Response.json({ mode: 'week', days: summary })
  }

  const result = await computeAvailability(prisma, {
    orgId: org.id,
    serviceId: parsed.data.serviceId,
    localDate: parsed.data.date,
    staffId: parsed.data.staffId,
  })
  return Response.json({ mode: 'day', ...result })
})
