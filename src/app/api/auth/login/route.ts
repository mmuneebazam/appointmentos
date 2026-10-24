import { z } from 'zod'
import { handler, badRequest, tooMany } from '@/lib/errors'
import { login } from '@/server/auth'
import { clientIp, rateLimit } from '@/server/ratelimit'
import { prisma } from '@/lib/db'

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
})

export const POST = handler(async (req: Request) => {
  // Credential stuffing is the single most likely attack on this endpoint.
  const limit = rateLimit(`login:${clientIp(req)}`, 10, 5 * 60_000)
  if (!limit.ok) throw tooMany('Too many sign-in attempts. Try again in a few minutes.')

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest('Enter your email and password')

  const user = await login(parsed.data.email, parsed.data.password)
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { org: true },
  })
  return Response.json({
    user: { id: user.id, name: user.name, email: user.email },
    organizations: memberships.map((m) => ({ slug: m.org.slug, name: m.org.name, role: m.role })),
  })
})
