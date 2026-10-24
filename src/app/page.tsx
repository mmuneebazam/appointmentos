import Link from 'next/link'

const DEMO = {
  dashboard: '/dashboard',
  booking: '/book/northside',
  email: 'owner@northside.test',
  password: 'demo1234',
}

const INVARIANTS = [
  {
    title: 'No double bookings',
    body: 'Occupancy is written as unique quarter-hour ticks inside the booking transaction. Two racing requests collide on a database index — not in a UI check that a stale tab can bypass.',
    tag: 'database constraint',
  },
  {
    title: 'Money is authoritative',
    body: 'The payment webhook — not the HTTP response — confirms a booking. Duplicate, late and out-of-order events are all handled, and every handler is safe to run twice.',
    tag: 'idempotent webhooks',
  },
  {
    title: 'Slots are held, not promised',
    body: 'Picking a time creates a 10-minute hold with its own occupancy, so checkout cannot lose the slot. Holds expire on their own and hand the time back.',
    tag: 'expiring holds',
  },
  {
    title: 'Time zones done properly',
    body: 'Availability walks the local wall clock, so a 09:00 appointment stays 09:00 across daylight-saving transitions instead of drifting an hour.',
    tag: 'DST-safe scheduling',
  },
]

const FEATURES = [
  {
    heading: 'Customer booking',
    items: [
      'Public booking page per organisation',
      'Live availability across staff and locations',
      'Guest or account checkout with deposits',
      'Self-serve reschedule and cancellation',
      'Cancellation policy with automatic refunds',
    ],
  },
  {
    heading: 'Scheduling engine',
    items: [
      'Recurring working hours with breaks',
      'Leave, holidays and ad-hoc extra hours',
      'Per-service buffers before and after',
      'Group bookings with seat limits',
      'Multi-location, time-zone aware',
    ],
  },
  {
    heading: 'Business dashboard',
    items: [
      'Day, week and list calendar views',
      'Revenue, utilisation and cancellation metrics',
      'Customer history and lifetime value',
      'Notification and payment audit trail',
      'Operational queue and webhook inspector',
    ],
  },
  {
    heading: 'Platform concerns',
    items: [
      'Tenant isolation enforced server-side',
      'Signed webhooks and replay protection',
      'Durable job queue with dead-lettering',
      'Calendar sync (Google, Microsoft)',
      'Structured audit log for every change',
    ],
  },
]

const STACK = [
  ['Framework', 'Next.js 15 · React 19 · TypeScript'],
  ['Data', 'PostgreSQL-portable Prisma schema (SQLite in this demo)'],
  ['Jobs', 'Durable DB-backed queue, BullMQ-compatible contract'],
  ['Money', 'Stripe-compatible intents, HMAC-signed webhooks'],
  ['Calendar', 'Google Calendar & Microsoft Graph adapters'],
  ['Tests', '47 Vitest cases incl. concurrency and replay'],
]

function Check({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className={className} aria-hidden>
      <path
        d="M3 8.5l3 3 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function LandingPage() {
  return (
    <main className="marketing min-h-screen">
      <div className="marketing-grid">
        {/* ── nav ─────────────────────────────────────────────── */}
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-[15px] font-bold text-white">
              A
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white">AppointmentOS</span>
            <span className="ml-1 hidden rounded-md border border-slate-700 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-400 sm:inline">
              project 01
            </span>
          </div>
          <nav className="flex items-center gap-1 text-[13.5px] text-slate-300">
            <Link href="/docs" className="hidden rounded-lg px-3 py-2 hover:bg-white/5 hover:text-white sm:block">
              Architecture
            </Link>
            <Link href={DEMO.booking} className="hidden rounded-lg px-3 py-2 hover:bg-white/5 hover:text-white sm:block">
              Book a demo slot
            </Link>
            <Link
              href={DEMO.dashboard}
              className="rounded-lg bg-white px-3.5 py-2 font-semibold text-slate-900 hover:bg-slate-100"
            >
              Open dashboard
            </Link>
          </nav>
        </header>

        {/* ── hero ────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-8 pt-10 sm:pt-16">
          <div className="grid items-start gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="rise">
              <span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-1 text-[11.5px] font-medium text-indigo-200">
                <span className="dot bg-emerald-400 pulse-soft" />
                Multi-tenant scheduling · live demo with seeded data
              </span>

              <h1 className="mt-5 text-[40px] font-semibold leading-[1.08] text-white sm:text-[52px]">
                Booking software that
                <span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-teal-200 bg-clip-text text-transparent">
                  {' '}
                  refuses to double book.
                </span>
              </h1>

              <p className="mt-5 max-w-xl text-[15.5px] leading-relaxed text-slate-300">
                A production-shaped appointment platform for clinics, consultants and studios. Real scheduling
                logic, real payments, real calendar sync — built so that the failure cases are handled, tested and
                visible, not hidden behind a happy-path demo.
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link href={DEMO.dashboard} className="btn btn-primary !px-5 !py-2.5 !text-[14px]">
                  Open the dashboard
                </Link>
                <Link
                  href={DEMO.booking}
                  className="btn !border-slate-700 !bg-transparent !px-5 !py-2.5 !text-[14px] !text-slate-200 hover:!bg-white/5"
                >
                  Try the customer flow →
                </Link>
                <Link href="/docs" className="px-1 text-[13.5px] text-slate-400 underline-offset-4 hover:text-white hover:underline">
                  Read the architecture notes
                </Link>
              </div>

              <div className="mt-8 grid gap-2 text-[12.5px] text-slate-400 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Check className="text-emerald-400" /> 47 automated tests, incl. concurrency
                </div>
                <div className="flex items-center gap-2">
                  <Check className="text-emerald-400" /> Duplicate-webhook replay demos
                </div>
                <div className="flex items-center gap-2">
                  <Check className="text-emerald-400" /> Tenant isolation proven by test
                </div>
                <div className="flex items-center gap-2">
                  <Check className="text-emerald-400" /> Seeded with 48 appointments
                </div>
              </div>
            </div>

            {/* demo credentials card */}
            <div className="glass rise rounded-2xl p-5" style={{ animationDelay: '80ms' }}>
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] font-semibold uppercase tracking-wider text-slate-400">
                  Demo access
                </span>
                <span className="badge badge-green !border-emerald-400/30 !bg-emerald-400/10 !text-emerald-300">
                  seeded
                </span>
              </div>
              <dl className="mt-3 space-y-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2.5">
                  <dt className="text-slate-400">Owner (full access)</dt>
                  <dd className="font-mono text-slate-100">{DEMO.email}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2.5">
                  <dt className="text-slate-400">Password</dt>
                  <dd className="font-mono text-slate-100">{DEMO.password}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2.5">
                  <dt className="text-slate-400">Staff (limited role)</dt>
                  <dd className="font-mono text-slate-100">jonas@northside.test</dd>
                </div>
              </dl>
              <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
                Public booking page:{' '}
                <Link href={DEMO.booking} className="text-indigo-300 hover:text-indigo-200">
                  /book/northside
                </Link>{' '}
                — no sign-in needed. Payments run through a local mock provider that emits genuinely signed
                webhooks.
              </p>
            </div>
          </div>
        </section>

        {/* ── invariants ──────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-8">
          <div className="grid gap-3 sm:grid-cols-2">
            {INVARIANTS.map((item) => (
              <div key={item.title} className="glass rounded-xl p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[14.5px] font-semibold text-white">{item.title}</h3>
                  <span className="rounded-md border border-slate-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-400">
                    {item.tag}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── features on light surface ─────────────────────────── */}
      <section className="bg-[#f6f7fb] px-6 py-16 text-gray-900">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <span className="label">Scope</span>
            <h2 className="mt-1.5 text-[28px] font-semibold tracking-tight">
              Everything a real booking business needs — including the boring parts
            </h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-gray-600">
              The product surface is deliberately complete: a customer can book and manage their own appointment,
              staff can run their day, and the owner can see money, occupancy and operations in one place.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((group) => (
              <div key={group.heading} className="card card-pad">
                <h3 className="text-[13.5px] font-semibold text-gray-900">{group.heading}</h3>
                <ul className="mt-3 space-y-2">
                  {group.items.map((item) => (
                    <li key={item} className="flex gap-2 text-[12.5px] leading-snug text-gray-600">
                      <Check className="mt-0.5 shrink-0 text-indigo-500" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── architecture ─────────────────────────────────────── */}
      <section className="marketing px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr]">
            <div>
              <span className="label !text-slate-400">Architecture</span>
              <h2 className="mt-1.5 text-[26px] font-semibold tracking-tight text-white">
                A modular monolith that knows where its consistency boundaries are
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-slate-400">
                One deployable Next.js application plus a separate worker process. Scheduling correctness lives in
                Postgres-shaped constraints; everything slow or flaky (email, SMS, calendar sync, refunds) is pushed
                through a durable queue with backoff and dead-lettering.
              </p>

              <dl className="mt-6 space-y-2.5">
                {STACK.map(([label, value]) => (
                  <div key={label} className="flex gap-4 border-b border-slate-800 pb-2.5 last:border-0">
                    <dt className="w-24 shrink-0 text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">
                      {label}
                    </dt>
                    <dd className="text-[13px] text-slate-300">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="glass rounded-2xl p-5">
              <svg viewBox="0 0 520 330" width="100%" role="img" aria-label="System architecture diagram">
                <defs>
                  <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
                  </marker>
                </defs>

                {/* client */}
                <rect x="12" y="12" width="150" height="58" rx="9" fill="#111a2e" stroke="#334155" />
                <text x="87" y="36" textAnchor="middle" fill="#e2e8f0" fontSize="11.5" fontWeight="600">
                  Customer
                </text>
                <text x="87" y="52" textAnchor="middle" fill="#94a3b8" fontSize="10">
                  /book/northside
                </text>

                <rect x="352" y="12" width="156" height="58" rx="9" fill="#111a2e" stroke="#334155" />
                <text x="430" y="36" textAnchor="middle" fill="#e2e8f0" fontSize="11.5" fontWeight="600">
                  Staff dashboard
                </text>
                <text x="430" y="52" textAnchor="middle" fill="#94a3b8" fontSize="10">
                  Next.js RSC + API
                </text>

                {/* app */}
                <rect x="150" y="108" width="220" height="104" rx="10" fill="#1a2440" stroke="#4f46e5" />
                <text x="260" y="130" textAnchor="middle" fill="#c7d2fe" fontSize="11.5" fontWeight="600">
                  Application (Next.js)
                </text>
                <text x="260" y="148" textAnchor="middle" fill="#a5b4fc" fontSize="10">
                  availability · booking tx · webhooks
                </text>
                <text x="260" y="164" textAnchor="middle" fill="#a5b4fc" fontSize="10">
                  tenant guard · audit
                </text>
                <rect x="170" y="176" width="180" height="24" rx="6" fill="#0d1830" stroke="#334155" />
                <text x="260" y="192" textAnchor="middle" fill="#93c5fd" fontSize="9.5">
                  public REST API + /api/openapi
                </text>

                {/* db */}
                <rect x="36" y="248" width="150" height="62" rx="9" fill="#111a2e" stroke="#0d9488" />
                <text x="111" y="272" textAnchor="middle" fill="#5eead4" fontSize="11.5" fontWeight="600">
                  Database
                </text>
                <text x="111" y="288" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  unique slot ticks,
                </text>
                <text x="111" y="301" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  job queue, audit log
                </text>

                {/* worker */}
                <rect x="212" y="248" width="140" height="62" rx="9" fill="#111a2e" stroke="#334155" />
                <text x="282" y="272" textAnchor="middle" fill="#e2e8f0" fontSize="11.5" fontWeight="600">
                  Worker
                </text>
                <text x="282" y="288" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  retries · dead-letter
                </text>
                <text x="282" y="301" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  reminders · calendar
                </text>

                {/* providers */}
                <rect x="378" y="248" width="130" height="62" rx="9" fill="#111a2e" stroke="#334155" />
                <text x="443" y="270" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="600">
                  Providers
                </text>
                <text x="443" y="286" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  Stripe · Resend
                </text>
                <text x="443" y="299" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
                  Google · Twilio
                </text>

                {/* edges */}
                <line x1="87" y1="70" x2="200" y2="108" stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arrow)" />
                <line x1="430" y1="70" x2="320" y2="108" stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arrow)" />
                <line x1="200" y1="212" x2="120" y2="248" stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arrow)" />
                <line x1="260" y1="212" x2="280" y2="248" stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arrow)" />
                <line x1="352" y1="278" x2="378" y2="278" stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arrow)" />
                <line x1="240" y1="248" x2="150" y2="212" stroke="#334155" strokeWidth="1.2" strokeDasharray="3 3" markerEnd="url(#arrow)" />

                <text x="262" y="232" fill="#64748b" fontSize="9">
                  claims jobs atomically
                </text>
              </svg>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-800 px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 text-[12.5px] text-slate-500 sm:flex-row sm:items-center">
          <span>AppointmentOS — project 01 of the full-stack portfolio series.</span>
          <div className="flex gap-4">
            <Link href="/docs" className="hover:text-slate-300">
              Architecture
            </Link>
            <Link href="/api/health" className="hover:text-slate-300">
              Health check
            </Link>
            <Link href="/api/openapi" className="hover:text-slate-300">
              OpenAPI
            </Link>
          </div>
        </div>
      </footer>
    </main>
  )
}
