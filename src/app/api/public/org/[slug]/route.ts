import { prisma } from '@/lib/db'
import { handler } from '@/lib/errors'
import { notFound } from '@/lib/errors'

/** Public booking-page bootstrap: the org, its services and its team. */
export const GET = handler(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params
  const org = await prisma.organization.findUnique({
    where: { slug },
    include: {
      locations: { where: { isDefault: true }, take: 1 },
      services: {
        where: { active: true },
        orderBy: { priceCents: 'asc' },
        include: { staffLinks: { include: { staff: true } } },
      },
    },
  })
  if (!org) throw notFound('That booking page does not exist')

  return Response.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      currency: org.currency,
      timezone: org.locations[0]?.timezone ?? org.timezone,
      location: org.locations[0]?.name ?? 'Studio',
      address: org.locations[0]?.address ?? null,
      brandColor: org.brandColor,
      depositRequired: org.depositRequired,
      cancellationWindowHrs: org.cancellationWindowHrs,
      holdMinutes: org.slotHoldMinutes,
    },
    services: org.services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      depositCents: s.depositCents,
      isGroup: s.isGroup,
      maxParticipants: s.maxParticipants,
      staff: s.staffLinks.map((l) => ({ id: l.staff.id, name: l.staff.name, color: l.staff.color })),
    })),
  })
})
