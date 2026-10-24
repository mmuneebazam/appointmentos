import { handler } from '@/lib/errors'
import { requireMembership } from '@/server/auth'
import { operationsSnapshot, notificationLog } from '@/server/queries'
import { queueDepth } from '@/server/jobs'

export const GET = handler(async () => {
  const tenant = await requireMembership()
  const [snapshot, notifications, depth] = await Promise.all([
    operationsSnapshot({ orgId: tenant.org.id }),
    notificationLog({ orgId: tenant.org.id, take: 30 }),
    queueDepth(),
  ])
  return Response.json({ ...snapshot, notifications, queueDepth: depth })
})
