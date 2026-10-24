import { handler } from '@/lib/errors'
import { requireMembership, requireManager } from '@/server/auth'
import { completeAppointment } from '@/server/booking'

export const POST = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const tenant = await requireMembership()
  requireManager(tenant)
  const { id } = await ctx.params
  const result = await completeAppointment({ orgId: tenant.org.id, appointmentId: id })
  return Response.json(result)
})
