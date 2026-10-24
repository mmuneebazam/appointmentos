import { prisma } from '@/lib/db'
import { features } from '@/lib/env'
import { queueDepth } from '@/server/jobs'
import { handler } from '@/lib/errors'

/** Readiness probe: proves the database is reachable, not just that Node is up. */
export const GET = handler(async () => {
  const startedAt = Date.now()
  await prisma.$queryRaw`SELECT 1`
  const depth = await queueDepth().catch(() => ({}))
  return Response.json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds: Math.round(process.uptime()),
    database: { ok: true, latencyMs: Date.now() - startedAt },
    queue: depth,
    integrations: features,
  })
})
