import Link from 'next/link'
import { requirePageTenant } from '@/server/guard'
import { listAppointments } from '@/server/queries'
import { prisma } from '@/lib/db'
import { Card, StatusBadge, EmptyState } from '@/components/ui'
import { formatMoney } from '@/lib/money'
import { formatDateTime } from '@/lib/time'

export const dynamic = 'force-dynamic'

const FILTERS = ['ALL', 'CONFIRMED', 'PENDING_PAYMENT', 'COMPLETED', 'CANCELLED'] as const

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; staff?: string; page?: string }>
}) {
  const ctx = await requirePageTenant()
  const params = await searchParams
  const status = params.status ?? 'ALL'
  const page = Math.max(1, Number(params.page ?? 1) || 1)
  const take = 25

  const [{ rows, total }, staff] = await Promise.all([
    listAppointments({
      orgId: ctx.org.id,
      status,
      staffId: params.staff,
      take,
      skip: (page - 1) * take,
    }),
    prisma.staff.findMany({ where: { orgId: ctx.org.id, active: true }, select: { id: true, name: true } }),
  ])

  const pages = Math.max(1, Math.ceil(total / take))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">Bookings</p>
          <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-gray-900">Appointments</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {total} record{total === 1 ? '' : 's'} · newest first
          </p>
        </div>
        <Link href="/book/northside" className="btn btn-primary">
          New booking
        </Link>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((filter) => (
          <Link
            key={filter}
            href={`/dashboard/appointments?status=${filter}`}
            className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium ${
              status === filter
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                : 'border-[var(--color-line)] bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {filter === 'ALL' ? 'All' : filter.replace('_', ' ').toLowerCase()}
          </Link>
        ))}
      </div>

      <Card pad={false}>
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No appointments match this filter" />
          </div>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[820px] text-left">
              <thead>
                <tr className="border-b border-[var(--color-line)] bg-[#fbfcfe] text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2.5 font-semibold">When</th>
                  <th className="px-4 py-2.5 font-semibold">Customer</th>
                  <th className="px-4 py-2.5 font-semibold">Service</th>
                  <th className="px-4 py-2.5 font-semibold">Staff</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Value</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Paid</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-[#f3f4f8] last:border-0 hover:bg-[#fbfcfe]">
                    <td className="num whitespace-nowrap px-4 py-2.5 text-[12.5px] text-gray-800">
                      <Link href={`/dashboard/appointments/${row.id}`} className="hover:text-indigo-600">
                        {formatDateTime(row.startsAt, ctx.org.timezone)}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-[12.5px] font-medium text-gray-900">{row.customer.name}</p>
                      <p className="text-[11.5px] text-gray-500">{row.customer.email}</p>
                    </td>
                    <td className="px-4 py-2.5 text-[12.5px] text-gray-700">{row.service.name}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-[12.5px] text-gray-700">
                        <span className="dot" style={{ background: row.staff.color }} />
                        {row.staff.name}
                      </span>
                    </td>
                    <td className="num px-4 py-2.5 text-right text-[12.5px] text-gray-800">
                      {formatMoney(row.priceCents, row.currency)}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-[12.5px] text-gray-600">
                      {formatMoney(row.amountPaidCents, row.currency)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pages > 1 ? (
        <div className="flex items-center justify-between text-[12.5px] text-gray-600">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={`/dashboard/appointments?status=${status}&page=${page - 1}`} className="btn btn-secondary !py-1.5">
                Previous
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={`/dashboard/appointments?status=${status}&page=${page + 1}`} className="btn btn-secondary !py-1.5">
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-[11.5px] text-gray-400">
          Filtering by staff: add <code className="font-mono">&amp;staff=&lt;id&gt;</code> to the URL.
          {staff.length ? ` ${staff.length} active staff.` : ''}
        </p>
      )}
    </div>
  )
}
