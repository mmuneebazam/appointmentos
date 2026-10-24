import { requirePageTenant } from '@/server/guard'
import { operationsSnapshot, notificationLog } from '@/server/queries'
import { queueDepth } from '@/server/jobs'
import { Card, EmptyState, SectionHeader, StatusBadge } from '@/components/ui'
import { formatDateTime, relativeLabel } from '@/lib/time'
import { env, features } from '@/lib/env'
import { OpsControls } from './ops-controls'

export const dynamic = 'force-dynamic'

export default async function OperationsPage() {
  const ctx = await requirePageTenant()
  const zone = ctx.org.timezone
  const [snapshot, notifications, depth] = await Promise.all([
    operationsSnapshot({ orgId: ctx.org.id }),
    notificationLog({ orgId: ctx.org.id, take: 20 }),
    queueDepth(),
  ])

  const connected = new Set(snapshot.accounts.map((a) => a.provider))

  return (
    <div className="space-y-4">
      <div>
        <p className="label">Reliability</p>
        <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-gray-900">Operations</h2>
        <p className="mt-0.5 max-w-2xl text-[13px] text-gray-500">
          Everything asynchronous, inspectable: the job queue with retries and dead-letters, webhook deliveries,
          active slot holds, notification delivery and calendar sync state.
        </p>
      </div>

      <OpsControls
        queueDepth={depth}
        connected={[connected.has('GOOGLE_CALENDAR'), connected.has('MICROSOFT_GRAPH')]}
        transport={{
          email: features.resend ? 'resend (live)' : 'console sink',
          sms: features.twilio ? 'twilio (live)' : 'console sink',
          payments: features.stripe ? 'stripe (live)' : 'mock provider (signed webhooks)',
          calendar: env.CALENDAR_PROVIDER,
        }}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionHeader title="Job queue" hint="Newest 25 jobs · durable, at-least-once" />
          <div className="mt-3 space-y-1.5">
            {snapshot.jobs.length === 0 ? (
              <EmptyState title="Queue is empty" />
            ) : (
              snapshot.jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-[var(--color-line)] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11.5px] text-gray-800">{job.type}</span>
                    <StatusBadge status={job.status} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    attempt {job.attempts}/{job.maxAttempts} · runs {relativeLabel(job.runAt, new Date())}
                  </p>
                  {job.lastError ? (
                    <p className="mt-0.5 text-[11px] text-[#b42318]">{job.lastError}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <SectionHeader
            title="Webhook deliveries"
            hint="Signature-verified, replay-protected by provider event id"
          />
          <div className="mt-3 space-y-1.5">
            {snapshot.webhooks.length === 0 ? (
              <EmptyState title="No webhook events yet" hint="Run a demo checkout to generate one." />
            ) : (
              snapshot.webhooks.map((event) => (
                <div key={event.id} className="rounded-lg border border-[var(--color-line)] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-gray-700">{event.externalId}</span>
                    <StatusBadge status={event.status} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {event.type} · received {formatDateTime(event.receivedAt, zone)}
                  </p>
                  {event.error ? <p className="mt-0.5 text-[11px] text-amber-700">{event.error}</p> : null}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Active slot holds" hint="Expire automatically; the slot returns to the pool" />
          <div className="mt-3 space-y-1.5">
            {snapshot.holds.length === 0 ? (
              <EmptyState title="No live holds" />
            ) : (
              snapshot.holds.map((hold) => (
                <div
                  key={hold.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                >
                  <div>
                    <p className="text-[12px] font-medium text-gray-800">
                      {hold.service.name} · {hold.staff.name}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      starts {formatDateTime(hold.startsAt, zone)}
                    </p>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={hold.status} />
                    <p className="mt-0.5 text-[10.5px] text-gray-500">
                      expires {relativeLabel(hold.expiresAt, new Date())}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Notification delivery" hint="Exactly one message per appointment event" />
          <div className="mt-3 space-y-1.5">
            {notifications.length === 0 ? (
              <EmptyState title="Nothing sent yet" />
            ) : (
              notifications.map((notification) => (
                <div
                  key={notification.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-gray-800">
                      {notification.template.replace(/_/g, ' ').toLowerCase()} ·{' '}
                      {notification.channel.toLowerCase()}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">{notification.recipient}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10.5px] text-gray-400">
                      {notification.sentAt
                        ? formatDateTime(notification.sentAt, zone)
                        : relativeLabel(notification.sendAt, new Date())}
                    </span>
                    <StatusBadge status={notification.status} />
                  </div>
                  {notification.lastError ? (
                    <p className="w-full text-[11px] text-[#b42318]">{notification.lastError}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card>
        <SectionHeader
          title="Integration state"
          hint="Adapters fall back to local simulators when credentials are absent"
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Payments', features.stripe ? 'Stripe live' : 'Mock provider'],
            ['Email', features.resend ? 'Resend live' : 'Console sink'],
            ['SMS', features.twilio ? 'Twilio live' : 'Console sink'],
            ['Calendar', env.CALENDAR_PROVIDER],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-[var(--color-line)] bg-[#fbfcfe] px-3 py-2.5">
              <p className="label">{label}</p>
              <p className="mt-0.5 text-[12.5px] font-medium text-gray-800">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1.5">
          {snapshot.accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-2"
            >
              <div>
                <p className="text-[12px] font-medium text-gray-800">
                  {account.provider.replace('_', ' ').toLowerCase()}
                </p>
                <p className="text-[11px] text-gray-500">
                  connected {formatDateTime(account.connectedAt, zone)} · scope {account.scope || 'n/a'}
                </p>
              </div>
              <span className="badge badge-green">connected</span>
            </div>
          ))}
          {snapshot.accounts.length === 0 ? (
            <p className="text-[12.5px] text-gray-500">
              No calendars connected. Connect one above to start writing events.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
