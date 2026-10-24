import { handler } from '@/lib/errors'
import { clearSessionCookie } from '@/server/auth'

export const POST = handler(async () => {
  await clearSessionCookie()
  return Response.json({ ok: true })
})
