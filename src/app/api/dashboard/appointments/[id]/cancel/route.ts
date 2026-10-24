import { z } from 'zod'
import { handler, badRequest } from '@/lib/errors'
import { requireMembership, requireManager } from '@/server/auth'
import { cancelAppointment } from '@/server/booking'

const bodySchema = z.object({ reason: z.string().max(500).optional() })

export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const tenant = await requireMembership()
  requireManager({ ...tenant })
  const { id } = await ctx.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) throw badRequest('Invalid request')

  // The orgId comes from the session, never from the request body — that is
  // what stops a caller from cancelling another tenant's appointment.
  const result = await cancelAppointment({
    orgId: tenant.org.id,
    appointmentId: id,
    reason: parsed.data.reason,
    actor: { type: 'STAFF', id: tenant.user.id, name: tenant.user.name },
  })
  return Response.json(result)
})
