import { z } from 'zod'
import { prisma } from '@/lib/db'
import { handler, badRequest, notFound } from '@/lib/errors'
import { createBooking } from '@/server/booking'
import { clientIp, rateLimit } from '@/server/ratelimit'
import { signAppointmentToken } from '@/server/tokens'

const bodySchema = z.object({
  orgSlug: z.string().min(1),
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  startsAt: z.string().datetime(),
  holdToken: z.string().optional(),
  customer: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().max(32).optional().nullable(),
    timezone: z.string().max(64).optional(),
  }),
  notes: z.string().max(1000).optional(),
  /** Client-generated so a double-submit or a network retry cannot double book. */
  idempotencyKey: z.string().min(8).max(120).optional(),
  seats: z.number().int().min(1).max(20).optional(),
})

export const POST = handler(async (req: Request) => {
  const limit = rateLimit(`book:${clientIp(req)}`, 10, 60_000)
  if (!limit.ok) {
    return Response.json(
      { error: { code: 'rate_limited', message: 'Too many booking attempts. Please wait a minute.' } },
      { status: 429 },
    )
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Please check the booking details', parsed.error.issues)

  const org = await prisma.organization.findUnique({ where: { slug: parsed.data.orgSlug } })
  if (!org) throw notFound('Unknown organization')

  const result = await createBooking({
    orgId: org.id,
    serviceId: parsed.data.serviceId,
    staffId: parsed.data.staffId,
    startsAt: parsed.data.startsAt,
    holdToken: parsed.data.holdToken,
    customer: parsed.data.customer,
    notes: parsed.data.notes,
    idempotencyKey: parsed.data.idempotencyKey,
    seats: parsed.data.seats,
    actor: { type: 'CUSTOMER' },
    ip: clientIp(req),
  })

  const customer = await prisma.customer.findFirst({
    where: { orgId: org.id, email: parsed.data.customer.email.toLowerCase() },
  })

  return Response.json(
    {
      ...result,
      manageToken: signAppointmentToken(result.appointment.id, customer?.email ?? parsed.data.customer.email),
      requiresPayment: Boolean(result.payment),
    },
    { status: result.replayed ? 200 : 201 },
  )
})
