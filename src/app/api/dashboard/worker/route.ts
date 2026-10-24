import { handler } from '@/lib/errors'
import { requireMembership, requireManager } from '@/server/auth'
import { drainOnce } from '@/worker'

/**
 * Run the queue once from the dashboard.
 *
 * In production the worker is its own process (`npm run worker`). This endpoint
 * exists so a reviewer can watch a queued notification or calendar sync actually
 * execute without opening a second terminal — same code path, same guarantees.
 */
export const POST = handler(async () => {
  const tenant = await requireMembership()
  requireManager(tenant)
  const processed = await drainOnce(25)
  return Response.json({ processed })
})
