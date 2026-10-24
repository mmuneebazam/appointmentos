'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H10v6H4a1 1 0 0 1-1-1z' },
  { href: '/dashboard/calendar', label: 'Calendar', icon: 'M4 6h16v14H4zM8 3v5M16 3v5M4 11h16' },
  { href: '/dashboard/appointments', label: 'Appointments', icon: 'M7 4h10v3H7zM5 7h14v13H5zM9 12h6M9 16h4' },
  { href: '/dashboard/customers', label: 'Customers', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-6 8-6s8 2.7 8 6' },
  { href: '/dashboard/operations', label: 'Operations', icon: 'M12 3v3m0 12v3M3 12h3m12 0h3M6.3 6.3l2.1 2.1m7.3 7.3 2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1' },
]

export function SideNav({ orgName, role }: { orgName: string; role: string }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary fixed left-4 top-4 z-40 !px-2.5 !py-2 lg:hidden"
        aria-label="Toggle navigation"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <aside
        className={`fixed inset-y-0 left-0 z-30 w-[228px] shrink-0 border-r border-[var(--color-line)] bg-[#f1f3f9] p-3 transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 px-2 py-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-[13px] font-bold text-white">
            A
          </span>
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold leading-tight text-gray-900" title={orgName}>
              {orgName}
            </p>
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{role.toLowerCase()}</p>
          </div>
        </div>

        <nav className="mt-4 space-y-0.5">
          {NAV.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${
                  active
                    ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(16,24,40,0.06)]'
                    : 'text-gray-600 hover:bg-white/70 hover:text-gray-900'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke={active ? '#4f46e5' : '#6b7280'}
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={item.icon} />
                </svg>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="mt-5 rounded-xl border border-[var(--color-line)] bg-white p-3">
          <p className="text-[11.5px] font-semibold text-gray-900">Public booking page</p>
          <p className="mt-0.5 text-[11.5px] text-gray-500">Share this with customers.</p>
          <Link href="/book/northside" className="mt-2 block truncate font-mono text-[11.5px] text-indigo-600">
            /book/northside
          </Link>
        </div>

        <div className="absolute bottom-3 left-3 right-3">
          <Link href="/docs" className="block rounded-lg px-2.5 py-2 text-[12.5px] text-gray-600 hover:bg-white/70">
            Architecture notes
          </Link>
        </div>
      </aside>
    </>
  )
}

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function signOut() {
    setPending(true)
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <p className="text-[12.5px] font-semibold leading-tight text-gray-900">{name}</p>
        <p className="text-[11.5px] leading-tight text-gray-500">{email}</p>
      </div>
      <button type="button" onClick={signOut} className="btn btn-secondary !py-1.5 !text-[12.5px]" disabled={pending}>
        {pending ? '…' : 'Sign out'}
      </button>
    </div>
  )
}
