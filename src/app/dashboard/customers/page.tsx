import { requirePageTenant } from '@/server/guard'
import { customerDirectory } from '@/server/queries'
import { Card, EmptyState } from '@/components/ui'
import { formatMoney } from '@/lib/money'
import { formatDateTime } from '@/lib/time'

export const dynamic = 'force-dynamic'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const ctx = await requirePageTenant()
  const { q } = await searchParams
  const customers = await customerDirectory({ orgId: ctx.org.id, search: q })

  const totalValue = customers.reduce((sum, c) => sum + c.lifetimeValueCents, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">Directory</p>
          <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-gray-900">Customers</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            {customers.length} customer{customers.length === 1 ? '' : 's'} ·{' '}
            {formatMoney(totalValue, ctx.org.currency)} lifetime completed value
          </p>
        </div>
        <form action="/dashboard/customers" className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search name or email"
            className="input !w-[220px] !text-[12.5px]"
          />
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
        </form>
      </div>

      <Card pad={false}>
        {customers.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No customers yet" hint="Bookings create customer records automatically." />
          </div>
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-[var(--color-line)] bg-[#fbfcfe] text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2.5 font-semibold">Customer</th>
                  <th className="px-4 py-2.5 font-semibold">Contact</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Bookings</th>
                  <th className="px-4 py-2.5 font-semibold">Last visit</th>
                  <th className="px-4 py-2.5 font-semibold">Next visit</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Lifetime</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b border-[#f3f4f8] last:border-0 hover:bg-[#fbfcfe]">
                    <td className="px-4 py-2.5">
                      <p className="text-[12.5px] font-medium text-gray-900">{customer.name}</p>
                      <p className="text-[11px] text-gray-500">
                        joined {formatDateTime(customer.createdAt, ctx.org.timezone)}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-[12px] text-gray-700">{customer.email}</p>
                      <p className="text-[11px] text-gray-500">{customer.phone ?? '—'}</p>
                    </td>
                    <td className="num px-4 py-2.5 text-right text-[12.5px] text-gray-800">
                      {customer.completedBookings}
                      <span className="text-gray-400">/{customer.totalBookings}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-600">
                      {customer.lastVisit ? formatDateTime(customer.lastVisit, ctx.org.timezone) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-gray-600">
                      {customer.nextVisit ? formatDateTime(customer.nextVisit, ctx.org.timezone) : '—'}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-[12.5px] font-medium text-gray-900">
                      {formatMoney(customer.lifetimeValueCents, ctx.org.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
