import { handler } from '@/lib/errors'
import { requireMembership } from '@/server/auth'
import { listAppointments } from '@/server/queries'

export const GET = handler(async (req: Request) => {
  const ctx = await requireMembership()
  const url = new URL(req.url)
  const result = await listAppointments({
    orgId: ctx.org.id,
    status: url.searchParams.get('status') ?? undefined,
    staffId: url.searchParams.get('staffId') ?? undefined,
    take: Number(url.searchParams.get('take') ?? 25),
    skip: Number(url.searchParams.get('skip') ?? 0),
  })
  return Response.json(result)
})
