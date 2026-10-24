import { handler } from '@/lib/errors'
import { requireMembership } from '@/server/auth'
import { dashboardSummary, revenueByDay, staffWorkload, auditFeed } from '@/server/queries'

export const GET = handler(async () => {
  const ctx = await requireMembership()
  const zone = ctx.org.timezone
  const [summary, revenue, workload, audit] = await Promise.all([
    dashboardSummary({ orgId: ctx.org.id, zone }),
    revenueByDay({ orgId: ctx.org.id, zone, days: 14 }),
    staffWorkload({ orgId: ctx.org.id, zone }),
    auditFeed({ orgId: ctx.org.id, take: 12 }),
  ])
  return Response.json({ organization: ctx.org, user: ctx.user, role: ctx.role, summary, revenue, workload, audit })
})
