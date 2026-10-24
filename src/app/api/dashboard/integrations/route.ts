import { z } from 'zod'
import { handler, badRequest } from '@/lib/errors'
import { requireMembership, requireManager } from '@/server/auth'
import { connectDemoCalendar, disconnectCalendar, detectExternalConflicts } from '@/server/integrations/calendar'
import { prisma } from '@/lib/db'
import { recordAudit } from '@/server/audit'

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    provider: z.enum(['GOOGLE_CALENDAR', 'MICROSOFT_GRAPH']),
  }),
  z.object({ action: z.literal('disconnect'), provider: z.enum(['GOOGLE_CALENDAR', 'MICROSOFT_GRAPH']) }),
])

export const POST = handler(async (req: Request) => {
  const tenant = await requireMembership()
  requireManager(tenant)
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Invalid integration request')

  if (parsed.data.action === 'connect') {
    await connectDemoCalendar({
      orgId: tenant.org.id,
      userId: tenant.user.id,
      provider: parsed.data.provider,
    })
    await recordAudit({
      orgId: tenant.org.id,
      actorType: 'USER',
      actorId: tenant.user.id,
      action: 'integration.connected',
      entityType: 'ExternalAccount',
      entityId: parsed.data.provider,
      metadata: { summary: `connected ${parsed.data.provider.replace('_', ' ').toLowerCase()}`, actorName: tenant.user.name },
    })
    return Response.json({ ok: true, connected: parsed.data.provider })
  }

  await disconnectCalendar({ orgId: tenant.org.id, provider: parsed.data.provider })
  await recordAudit({
    orgId: tenant.org.id,
    actorType: 'USER',
    actorId: tenant.user.id,
    action: 'integration.disconnected',
    entityType: 'ExternalAccount',
    entityId: parsed.data.provider,
    metadata: { summary: `disconnected ${parsed.data.provider.replace('_', ' ').toLowerCase()}`, actorName: tenant.user.name },
  })
  return Response.json({ ok: true, disconnected: parsed.data.provider })
})

export const GET = handler(async () => {
  const tenant = await requireMembership()
  const accounts = await prisma.externalAccount.findMany({ where: { orgId: tenant.org.id } })
  const conflicts = await detectExternalConflicts({
    orgId: tenant.org.id,
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600_000),
  }).catch(() => [])
  return Response.json({
    accounts: accounts.map((a) => ({
      provider: a.provider,
      connectedAt: a.connectedAt,
      scope: a.scope,
      // Never return token material, even to the owning tenant.
    })),
    conflicts,
  })
})
