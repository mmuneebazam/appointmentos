import { z } from 'zod'
import { prisma } from '@/lib/db'
import { handler, badRequest, forbidden, notFound, tooMany } from '@/lib/errors'
import { verifyAppointmentToken } from '@/server/tokens'
import { cancelAppointment, rescheduleAppointment, evaluateCancellation } from '@/server/booking'
import { clientIp, rateLimit } from '@/server/ratelimit'
import { computeAvailability } from '@/server/availability'
import { localDateOf } from '@/lib/time'

async function loadFromToken(token: string) {
  const claims = verifyAppointmentToken(token)
  if (!claims) throw forbidden('This link is not valid. Check the link in your confirmation email.')
  const appointment = await prisma.appointment.findUnique({
    where: { id: claims.appointmentId },
    include: {
      service: true,
      staff: true,
      customer: true,
      location: true,
      org: true,
      payments: true,
    },
  })
  if (!appointment) throw notFound('Appointment not found')
  if (appointment.customer.email !== claims.email) throw forbidden('This link does not match the booking')
  return appointment
}

export const GET = handler(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params
  const appointment = await loadFromToken(token)
  const org = appointment.org
  const policy = evaluateCancellation({
    startsAt: appointment.startsAt,
    now: new Date(),
    windowHours: org.cancellationWindowHrs,
    amountPaidCents: appointment.amountPaidCents,
    priceCents: appointment.priceCents,
  })

  // Offer the next few days of availability for the reschedule picker.
  const zone = appointment.timezone
  const date = localDateOf(new Date(), zone)
  const availability = await computeAvailability(prisma, {
    orgId: org.id,
    serviceId: appointment.serviceId,
    localDate: date,
    staffId: appointment.staffId,
  })

  return Response.json({
    appointment: {
      id: appointment.id,
      status: appointment.status,
      startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(),
      timezone: zone,
      localDate: appointment.localDate,
      service: appointment.service.name,
      staff: appointment.staff.name,
      location: appointment.location.name,
      priceCents: appointment.priceCents,
      amountPaidCents: appointment.amountPaidCents,
      depositCents: appointment.depositCents,
      currency: appointment.currency,
      customerName: appointment.customer.name,
      notes: appointment.notes,
      cancellationReason: appointment.cancellationReason,
      payments: appointment.payments.map((p) => ({
        providerRef: p.providerRef,
        status: p.status,
        amountCents: p.amountCents,
      })),
    },
    organization: { name: org.name, slug: org.slug, currency: org.currency },
    policy,
    availability,
  })
})

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel'), reason: z.string().max(500).optional() }),
  z.object({
    action: z.literal('reschedule'),
    startsAt: z.string().datetime(),
    reason: z.string().max(500).optional(),
  }),
])

export const POST = handler(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params
  const limit = rateLimit(`manage:${clientIp(req)}`, 12, 60_000)
  if (!limit.ok) throw tooMany('Too many attempts. Please wait a minute.')

  const appointment = await loadFromToken(token)
  const parsed = actionSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Invalid request', parsed.error.issues)

  if (parsed.data.action === 'cancel') {
    const result = await cancelAppointment({
      orgId: appointment.orgId,
      appointmentId: appointment.id,
      reason: parsed.data.reason,
      actor: { type: 'CUSTOMER', id: appointment.customerId },
    })
    return Response.json(result)
  }

  const result = await rescheduleAppointment({
    orgId: appointment.orgId,
    appointmentId: appointment.id,
    startsAt: parsed.data.startsAt,
    reason: parsed.data.reason,
    actor: { type: 'CUSTOMER', id: appointment.customerId },
  })
  return Response.json(result)
})
