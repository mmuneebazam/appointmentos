import { z } from 'zod'
import { handler, badRequest } from '@/lib/errors'
import { requireMembership, requireManager } from '@/server/auth'
import { rescheduleAppointment } from '@/server/booking'

const bodySchema = z.object({ startsAt: z.string().datetime(), reason: z.string().max(500).optional() })

export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const tenant = await requireMembership()
  requireManager(tenant)
  const { id } = await ctx.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Invalid request', parsed.error.issues)

  const result = await rescheduleAppointment({
    orgId: tenant.org.id,
    appointmentId: id,
    startsAt: parsed.data.startsAt,
    reason: parsed.data.reason,
    actor: { type: 'STAFF', id: tenant.user.id, name: tenant.user.name },
  })
  return Response.json(result)
})
