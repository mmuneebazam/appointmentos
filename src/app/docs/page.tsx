import Link from 'next/link'

export const metadata = {
  title: 'AppointmentOS — architecture notes',
}

function Section({
  id,
  label,
  title,
  children,
}: {
  id: string
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <p className="label">{label}</p>
      <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-gray-900">{title}</h2>
      <div className="mt-3 space-y-3 text-[13.5px] leading-relaxed text-gray-700">{children}</div>
    </section>
  )
}

function Decision({
  title,
  status,
  context,
  decision,
  consequences,
}: {
  title: string
  status: string
  context: string
  decision: string
  consequences: string
}) {
  return (
    <div className="card card-pad">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[13.5px] font-semibold text-gray-900">{title}</h3>
        <span className="badge badge-green shrink-0">{status}</span>
      </div>
      <dl className="mt-2.5 space-y-2 text-[12.5px] leading-relaxed">
        <div>
          <dt className="label">Context</dt>
          <dd className="text-gray-700">{context}</dd>
        </div>
        <div>
          <dt className="label">Decision</dt>
          <dd className="text-gray-700">{decision}</dd>
        </div>
        <div>
          <dt className="label">Consequences</dt>
          <dd className="text-gray-700">{consequences}</dd>
        </div>
      </dl>
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[#0d1322] px-3.5 py-3 text-[11.5px] leading-relaxed text-slate-200 scroll-thin">
      <code className="font-mono">{children}</code>
    </pre>
  )
}

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-[var(--color-canvas)]">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-[13px] font-bold text-white">
              A
            </span>
            <span className="text-[14px] font-semibold text-gray-900">AppointmentOS</span>
          </Link>
          <nav className="flex gap-4 text-[12.5px] text-gray-600">
            <Link href="/dashboard" className="hover:text-gray-900">
              Dashboard
            </Link>
            <Link href="/book/northside" className="hover:text-gray-900">
              Booking page
            </Link>
            <a href="/api/openapi" className="hover:text-gray-900">
              OpenAPI
            </a>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <p className="label">Engineering notes</p>
        <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-gray-900">
          How AppointmentOS is built, and why
        </h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-gray-600">
          This page is the short version of the repository documentation: the invariants the system protects, the
          decisions behind them, the failure modes each one answers, and the honest limits of what is demonstrated
          here.
        </p>

        <nav className="mt-5 flex flex-wrap gap-1.5">
          {[
            ['invariants', 'Invariants'],
            ['booking', 'Booking transaction'],
            ['webhooks', 'Webhooks & money'],
            ['jobs', 'Durable jobs'],
            ['tenancy', 'Tenant isolation'],
            ['adr', 'Decision records'],
            ['try', 'Try the failure paths'],
            ['limits', 'Limitations'],
          ].map(([id, title]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-lg border border-[var(--color-line)] bg-white px-2.5 py-1.5 text-[12px] text-gray-600 hover:border-gray-300 hover:text-gray-900"
            >
              {title}
            </a>
          ))}
        </nav>

        <div className="mt-8 space-y-9">
          <Section id="invariants" label="01" title="The invariants, in one place">
            <p>
              Everything else in this document exists to keep these five statements true under concurrency,
              retries and hostile input:
            </p>
            <ol className="ml-4 list-decimal space-y-1.5 text-[13px]">
              <li>
                <strong>No two live appointments may overlap</strong> for the same staff member. Enforced by a
                unique index, not by a read-then-write check.
              </li>
              <li>
                <strong>A booking is confirmed by the payment provider, not by the HTTP response.</strong> A webhook
                can arrive late, twice, or out of order and the outcome is still correct.
              </li>
              <li>
                <strong>Every state change is attributable and exactly-once in its side effects</strong> — one audit
                row, at most one email per event, per appointment.
              </li>
              <li>
                <strong>No request can read or mutate a record belonging to another organisation</strong>, even when
                the record id is known.
              </li>
              <li>
                <strong>Time is stored as UTC instants and offered as local wall clock</strong>, so DST transitions
                never move a 09:00 appointment to 08:00 or 10:00.
              </li>
            </ol>
          </Section>

          <Section id="booking" label="02" title="The booking transaction">
            <p>
              A booking is a three-step negotiation: <strong>hold → confirm → pay</strong>. Each step is safe to
              repeat, and the slot is only ever owned by one of them at a time.
            </p>
            <Code>{`POST /api/public/holds        → SlotHold + occupancy ticks   (10 min TTL, own job to expire it)
POST /api/public/bookings     → Appointment + ticks inside one transaction
POST /api/webhooks/payments   → confirmed only when the provider says so

-- the guard, in SQL:
CREATE UNIQUE INDEX slot_lock_tick ON "SlotLock" ("staffId", "tickAt");`}</Code>
            <p>
              The appointment occupies <em>ticks</em> — one row per 15-minute segment between its block start and
              block end (service duration plus buffers). Two concurrent requests that overlap in any way collide on at
              least one tick, so the database decides the winner. A naive “is this slot free?” check followed by an
              insert would let both requests through; a unique index cannot be argued with.
            </p>
            <p>
              The availability engine re-runs <em>inside</em> the transaction before the insert. The grid the customer
              clicked may be several minutes old, so it is treated as a hint, never as proof.
            </p>
            <p className="rounded-lg border border-[var(--color-line)] bg-white px-3 py-2.5 text-[12.5px]">
              <strong>On Postgres</strong> the same invariant is expressed with{' '}
              <code className="font-mono">EXCLUDE USING gist (&quot;staffId&quot; WITH =, tstzrange(...) WITH &amp;&amp;)</code>,
              which removes the need for ticks entirely. The tick table is the portable version of the same idea and
              is documented in <code className="font-mono">docs/adr/0002</code>.
            </p>
          </Section>

          <Section id="webhooks" label="03" title="Webhooks, money and replay">
            <p>
              Money is authoritative at the provider, so the webhook — not the browser — decides whether a booking is
              paid. Three properties are enforced:
            </p>
            <ul className="ml-4 list-disc space-y-1.5 text-[13px]">
              <li>
                <strong>Signature first.</strong> HMAC over the raw body with a timestamp tolerance, verified before
                the payload is parsed. An unsigned or stale request gets a 401.
              </li>
              <li>
                <strong>Unique provider event id.</strong> The second delivery of an event is acknowledged with 200
                and changes nothing, which is exactly what stops the provider from retrying for hours.
              </li>
              <li>
                <strong>Monotonic status.</strong> A late <code className="font-mono">payment_failed</code> cannot
                un-succeed a captured payment; a repeated success cannot apply the amount twice.
              </li>
            </ul>
            <p>
              The booking confirmation email is gated by a dedupe key of{' '}
              <code className="font-mono">{'<appointmentId>:<template>'}</code>. Three duplicate deliveries therefore
              produce one email, one audit row and one payment state change.
            </p>
            <p>
              If an event arrives before our own payment row is visible, it is stored and re-queued rather than
              dropped — the classic lost-update window around a third-party callback.
            </p>
          </Section>

          <Section id="jobs" label="04" title="Durable background work">
            <p>
              Slow or flaky work — email, SMS, calendar sync, refunds, hold expiry — never runs inline with a request.
              Jobs live in a table with <code className="font-mono">runAt</code>,{' '}
              <code className="font-mono">attempts</code>, <code className="font-mono">maxAttempts</code> and a lock
              token.
            </p>
            <Code>{`claim:   UPDATE Job SET status='RUNNING', lockToken=$1 WHERE id=$2 AND status='QUEUED'
         -- claim is conditional, so two workers cannot take the same row
retry:   exponential backoff with full jitter (1s → 60s cap)
crash:   a RUNNING job whose lock is older than 2 minutes returns to QUEUED
poison:  after maxAttempts → DEAD_LETTER, with lastError kept for a human`}</Code>
            <p>
              Because delivery is at-least-once, every handler is written to be idempotent. The notification table
              carries a unique <code className="font-mono">dedupeKey</code>; calendar events use a deterministic
              provider-side id per appointment, so a retried sync updates instead of duplicating.
            </p>
            <p>
              The queue is implemented behind a BullMQ-shaped interface (<code className="font-mono">enqueue</code>,{' '}
              <code className="font-mono">claim</code>, <code className="font-mono">backoff</code>, dead-letter). To
              move to Redis you replace one file, not the call sites.
            </p>
          </Section>

          <Section id="tenancy" label="05" title="Tenant isolation and authorisation">
            <p>
              Every organisation-owned query starts from a session-derived <code className="font-mono">orgId</code>.
              Route handlers call <code className="font-mono">requireMembership()</code>, which returns a context
              object — not a nullable value — so a forgotten check fails closed with a 401 rather than silently
              becoming an open door.
            </p>
            <p>
              Role checks are separate: <code className="font-mono">requireManager()</code> gates destructive actions.
              The seeded <code className="font-mono">jonas@northside.test</code> account is a member and receives a
              403 when it tries to cancel or reschedule, which is verified in the test suite as well as by hand.
            </p>
            <p>
              Public surfaces are separately authorised. The customer’s manage link is an HMAC over{' '}
              <code className="font-mono">appointmentId:email</code>, so guessing an appointment id does not grant
              access to someone else’s booking.
            </p>
          </Section>

          <Section id="adr" label="06" title="Decision records">
            <div className="grid gap-3">
              <Decision
                title="ADR 0001 — Modular monolith over microservices"
                status="accepted"
                context="Scheduling, payments and notifications have genuinely different scaling profiles, but the team is one developer and correctness spans all three."
                decision="One Next.js application plus one worker process sharing a database. Module boundaries are enforced by directory and by function signatures, not by the network."
                consequences="Transactions stay simple and the whole system runs from one command. When notification volume justifies it, the worker is already a separate process and can be extracted with no domain changes."
              />
              <Decision
                title="ADR 0002 — Unique occupancy ticks as the double-booking guard"
                status="accepted"
                context="Availability must be race-proof. Application-level checks are advisory: two requests can both pass the check, then both insert."
                decision="Write one row per 15-minute tick the booking covers and make (staffId, tickAt) unique. On Postgres, replace with a tstzrange exclusion constraint."
                consequences="Collisions are detected by the database and surface as a friendly 409. Costs a few extra rows per booking and requires tick rows to be written inside the same transaction as the appointment."
              />
              <Decision
                title="ADR 0003 — Database-backed queue instead of Redis"
                status="accepted, revisit at scale"
                context="The demo must run anywhere with no infrastructure, but the reliability semantics of BullMQ are part of what this project demonstrates."
                decision="Persist jobs alongside domain data, with conditional claims, exponential backoff with jitter, stale-lock recovery and dead-lettering. Keep the interface identical to BullMQ."
                consequences="One fewer moving part and jobs are transactional with the booking that enqueued them. Polling is less efficient than Redis pub/sub, and the in-process rate limiter is per-instance — both are documented and both are swap-in replacements."
              />
              <Decision
                title="ADR 0004 — UTC instants plus preserved local wall clock"
                status="accepted"
                context="A recurring 09:00 shift must stay 09:00 across daylight-saving changes, but two people in different zones must agree on the instant."
                decision="Store startsAt/endsAt as UTC, and also store localDate, localStartMin and the booked timezone. Working hours are minutes-from-local-midnight and are resolved per date."
                consequences="DST gaps are skipped and overlaps resolve deterministically. Historical appointments keep rendering at the time they were booked even if the org later changes timezone."
              />
            </div>
          </Section>

          <Section id="try" label="07" title="Try the failure paths yourself">
            <p>Each of these produces a visible, non-destructive result in the running demo:</p>
            <Code>{`# 1. Two customers racing for the same slot (run twice, in parallel)
curl -s -X POST localhost:3000/api/public/holds -H 'content-type: application/json' \\
  -d '{"orgSlug":"northside","serviceId":"<id>","staffId":"<id>","startsAt":"<iso>"}'
#   → one 201, one 409 "Someone else just took that time"

# 2. An unsigned webhook
curl -s -o /dev/null -w '%{http_code}\\n' -X POST localhost:3000/api/webhooks/payments \\
  -H 'content-type: application/json' -d '{"id":"evt_x","type":"payment_intent.succeeded"}'
#   → 401

# 3. A duplicate webhook delivery
#   in the booking page, pay, then press "Re-deliver the same webhook"
#   → outcome "duplicate": no second charge, no second email

# 4. Drain the queue by hand
npm run worker:once

# 5. Cross-tenant access
#   sign in as barber@riverside.test and request a Northside appointment id
#   → 404, proven by tests/tenancy.test.ts`}</Code>
          </Section>

          <Section id="limits" label="08" title="Limitations — stated plainly">
            <ul className="ml-4 list-disc space-y-1.5 text-[13px]">
              <li>
                <strong>SQLite in this demo.</strong> The Prisma schema is Postgres-portable and the production
                delta is documented, but SQLite serialises writers; a production deployment should run Postgres with
                the exclusion constraint and <code className="font-mono">SERIALIZABLE</code> where needed.
              </li>
              <li>
                <strong>Payment provider is simulated by default.</strong> The mock emits real HMAC-signed webhooks
                so the flow is genuine, but the Stripe path is unexercised without keys. Card data never touches this
                server in either mode.
              </li>
              <li>
                <strong>Calendar OAuth is stubbed in demo mode.</strong> The Google and Microsoft adapters are real
                HTTP implementations behind an env flag; the local simulator implements the same interface including
                deterministic event ids.
              </li>
              <li>
                <strong>Notifications go to a console sink locally.</strong> The Resend and Twilio transports exist
                and are used when configured; delivery receipt tracking beyond the provider response is out of scope.
              </li>
              <li>
                <strong>Rate limiting is in-process.</strong> Fine for one instance and for the abuse cases that
                matter here; multi-instance needs a shared counter.
              </li>
              <li>
                <strong>No recurring appointments or waitlist auto-promotion.</strong> Waitlist candidates are
                surfaced for manual outreach rather than auto-booked — deliberately, because auto-booking on
                cancellation has policy implications that deserve a product decision.
              </li>
            </ul>
          </Section>
        </div>

        <div className="mt-10 flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-5">
          <Link href="/dashboard" className="btn btn-primary">
            Open the dashboard
          </Link>
          <Link href="/book/northside" className="btn btn-secondary">
            Customer booking flow
          </Link>
          <a href="/api/health" className="btn btn-secondary">
            Health check
          </a>
        </div>
      </div>
    </main>
  )
}
