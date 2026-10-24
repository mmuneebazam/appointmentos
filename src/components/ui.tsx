import Link from 'next/link'
import type { ReactNode } from 'react'

/* Small, dependency-free presentational primitives shared by every page. */

export function Card({
  children,
  className = '',
  pad = true,
}: {
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`}>{children}</div>
}

export function SectionHeader({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-[12.5px] text-gray-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: 'badge-green',
  PENDING_PAYMENT: 'badge-amber',
  COMPLETED: 'badge-blue',
  CANCELLED: 'badge-neutral',
  NO_SHOW: 'badge-red',
  SUCCEEDED: 'badge-green',
  REQUIRES_PAYMENT: 'badge-amber',
  FAILED: 'badge-red',
  REFUNDED: 'badge-violet',
  QUEUED: 'badge-amber',
  SENT: 'badge-green',
  DEAD_LETTER: 'badge-red',
  RUNNING: 'badge-blue',
  DONE: 'badge-green',
  PROCESSED: 'badge-green',
  SKIPPED: 'badge-neutral',
  RECEIVED: 'badge-blue',
  ACTIVE: 'badge-amber',
  CONSUMED: 'badge-green',
  EXPIRED: 'badge-neutral',
  RELEASED: 'badge-neutral',
  SYNCED: 'badge-green',
  DELETED: 'badge-neutral',
  PENDING: 'badge-amber',
}

export function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, ' ').toLowerCase()
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? 'badge-neutral'}`}>
      <span
        className="dot"
        style={{
          background:
            STATUS_STYLES[status] === 'badge-green'
              ? '#12b76a'
              : STATUS_STYLES[status] === 'badge-amber'
                ? '#f79009'
                : STATUS_STYLES[status] === 'badge-red'
                  ? '#f04438'
                  : STATUS_STYLES[status] === 'badge-blue'
                    ? '#2e90fa'
                    : STATUS_STYLES[status] === 'badge-violet'
                      ? '#7a5af8'
                      : '#98a2b3',
        }}
      />
      {label}
    </span>
  )
}

export function Stat({
  label,
  value,
  sub,
  trend,
  accent = 'brand',
}: {
  label: string
  value: string
  sub?: string
  trend?: number | null
  accent?: 'brand' | 'green' | 'amber' | 'red'
}) {
  const accentColor =
    accent === 'green' ? '#067647' : accent === 'amber' ? '#b54708' : accent === 'red' ? '#b42318' : '#4f46e5'
  return (
    <Card className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="num text-[26px] font-semibold leading-none text-gray-900" style={{ color: accentColor }}>
          {value}
        </span>
        {typeof trend === 'number' ? (
          <span
            className="num text-[12px] font-semibold"
            style={{ color: trend >= 0 ? '#067647' : '#b42318' }}
          >
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
          </span>
        ) : null}
      </div>
      {sub ? <span className="text-[12.5px] text-gray-500">{sub}</span> : null}
    </Card>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--color-line)] bg-[#fbfcfe] px-6 py-10 text-center">
      <span className="text-[13.5px] font-semibold text-gray-700">{title}</span>
      {hint ? <span className="max-w-sm text-[12.5px] text-gray-500">{hint}</span> : null}
    </div>
  )
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      <span className="text-[13.5px] text-gray-800">{value}</span>
    </div>
  )
}

export function Avatar({ name, color }: { name: string; color?: string | null }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
      style={{ background: color ?? '#4f46e5' }}
      aria-hidden
    >
      {initials}
    </span>
  )
}

export function Sparkline({
  points,
  height = 44,
  color = '#4f46e5',
}: {
  points: number[]
  height?: number
  color?: string
}) {
  if (points.length === 0) return null
  const max = Math.max(...points, 1)
  const width = 220
  const step = points.length > 1 ? width / (points.length - 1) : width
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(height - (p / max) * (height - 6) - 3).toFixed(1)}`)
    .join(' ')
  const area = `${path} L ${width} ${height} L 0 ${height} Z`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#grad-${color.replace('#', '')})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function NavLink({ href, children, active }: { href: string; children: ReactNode; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${
        active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:bg-white/60 hover:text-gray-900'
      }`}
    >
      {children}
    </Link>
  )
}
