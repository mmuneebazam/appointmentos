import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { BookingWizard } from './wizard'

export const dynamic = 'force-dynamic'

export default async function PublicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const org = await prisma.organization.findUnique({
    where: { slug },
    include: {
      locations: { orderBy: [{ isDefault: 'desc' }], take: 1 },
      services: {
        where: { active: true },
        orderBy: { priceCents: 'asc' },
        include: { staffLinks: { include: { staff: true } } },
      },
    },
  })
  if (!org) notFound()

  const location = org.locations[0]

  return (
    <main className="min-h-screen bg-[var(--color-canvas)]">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[14px] font-bold text-white"
              style={{ background: org.brandColor }}
            >
              {org.name.slice(0, 1)}
            </span>
            <div>
              <p className="text-[14px] font-semibold text-gray-900">{org.name}</p>
              <p className="text-[11.5px] text-gray-500">
                {location?.name ?? 'Main studio'}
                {location?.address ? ` · ${location.address}` : ''}
              </p>
            </div>
          </div>
          <Link href="/" className="text-[12px] text-gray-500 hover:text-gray-800">
            Powered by AppointmentOS
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-6">
        <BookingWizard
          org={{
            slug: org.slug,
            name: org.name,
            currency: org.currency,
            timezone: location?.timezone ?? org.timezone,
            brandColor: org.brandColor,
            depositRequired: org.depositRequired,
            cancellationWindowHrs: org.cancellationWindowHrs,
            holdMinutes: org.slotHoldMinutes,
          }}
          services={org.services.map((service) => ({
            id: service.id,
            name: service.name,
            description: service.description,
            durationMin: service.durationMin,
            priceCents: service.priceCents,
            depositCents: service.depositCents,
            isGroup: service.isGroup,
            maxParticipants: service.maxParticipants,
            staff: service.staffLinks.map((link) => ({
              id: link.staff.id,
              name: link.staff.name,
              title: link.staff.title,
              color: link.staff.color,
            })),
          }))}
        />
      </div>
    </main>
  )
}
