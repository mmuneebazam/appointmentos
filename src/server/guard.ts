import { redirect } from 'next/navigation'
import { requireMembership, type TenantContext } from './auth'

/**
 * Page-level guard.
 *
 * A layout redirect and a page render happen concurrently, so a page that throws
 * 401 can still paint an error boundary before the layout's redirect lands. Pages
 * therefore redirect instead of throwing; API routes keep throwing so the client
 * receives a proper 401 JSON body.
 */
export async function requirePageTenant(): Promise<TenantContext> {
  try {
    return await requireMembership()
  } catch {
    redirect('/login')
  }
}
