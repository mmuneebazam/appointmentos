import { redirect } from 'next/navigation'
import { currentUser, requireMembership } from '@/server/auth'
import { SideNav, UserMenu } from '@/components/shell'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user) redirect('/login')

  // requireMembership throws 403 for a logged-in user with no membership; here we
  // would rather send them somewhere useful than render an error boundary.
  let ctx
  try {
    ctx = await requireMembership()
  } catch {
    redirect('/login')
  }

  return (
    <div className="flex min-h-screen">
      <SideNav orgName={ctx.org.name} role={ctx.role} />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-[var(--color-line)] bg-white/85 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3 pl-10 lg:pl-0">
            <h1 className="text-[14px] font-semibold text-gray-900">Studio operations</h1>
            <span className="hidden badge badge-neutral sm:inline-flex">{ctx.org.timezone}</span>
            <span className="hidden badge badge-violet sm:inline-flex">{ctx.org.currency}</span>
          </div>
          <UserMenu name={ctx.user.name} email={ctx.user.email} />
        </header>
        <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  )
}
