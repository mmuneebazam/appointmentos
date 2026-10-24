import { verifyUnsubscribeToken } from '@/server/tokens'
import { prisma } from '@/lib/db'
import { handler } from '@/lib/errors'

/**
 * One-click unsubscribe. The token is an HMAC of the email address, so it
 * cannot be forged and does not require a login.
 */
export const GET = handler(async (req: Request) => {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const email = verifyUnsubscribeToken(token)
  if (!email) {
    return new Response('<h1>Invalid unsubscribe link</h1>', {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  await prisma.customer.updateMany({ where: { email }, data: { notes: 'UNSUBSCRIBED' } })
  return new Response(
    `<body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
      <h1 style="font-size:20px">You are unsubscribed</h1>
      <p style="color:#4b5563">We will not send further reminder emails to ${email}. Booking confirmations for existing appointments may still be sent.</p>
    </body>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
})
