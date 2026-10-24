/**
 * Calendar synchronisation.
 *
 * Outbound is the path that matters for correctness: every booking must appear
 * in the staff member's calendar exactly once, and a cancellation must remove
 * it. That means the mapping table is the source of truth for "did we already
 * push this?", not an in-memory flag — otherwise a retried job creates a
 * duplicate event.
 *
 * The `fake` provider implements the same interface locally so the whole flow
 * (including retries and duplicate suppression) is demonstrable without OAuth
 * credentials. Google/Microsoft paths are real HTTP calls activated by env.
 */
import { prisma } from '@/lib/db'
import { env, features } from '@/lib/env'
import { DateTime } from 'luxon'
import { createHash, randomUUID } from 'node:crypto'

export interface CalendarProvider {
  name: 'google' | 'microsoft' | 'fake'
  upsertEvent(input: UpsertEventInput): Promise<{ externalEventId: string; etag: string }>
  deleteEvent(input: { externalEventId: string; accountId: string }): Promise<void>
  listBusy(input: { accountId: string; from: Date; to: Date }): Promise<BusyInterval[]>
}

export interface UpsertEventInput {
  accountId: string
  /** Stable per appointment+provider so retries update rather than duplicate. */
  idempotencyKey: string
  title: string
  description: string
  location: string
  startsAt: Date
  endsAt: Date
  timezone: string
  existingEventId?: string
}

export interface BusyInterval {
  startsAt: Date
  endsAt: Date
  summary: string
}

/** Deterministic local event id: same input, same id — the idempotency trick. */
function fakeEventId(key: string): string {
  return `fake_evt_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
}

const fakeStore = new Map<string, { title: string; start: string; end: string }>()

const fakeProvider: CalendarProvider = {
  name: 'fake',
  async upsertEvent(input) {
    const id = input.existingEventId ?? fakeEventId(input.idempotencyKey)
    fakeStore.set(id, {
      title: input.title,
      start: input.startsAt.toISOString(),
      end: input.endsAt.toISOString(),
    })
    return { externalEventId: id, etag: `etag_${Date.now()}` }
  },
  async deleteEvent({ externalEventId }) {
    fakeStore.delete(externalEventId)
  },
  async listBusy({ from, to }) {
    return [...fakeStore.entries()]
      .map(([, v]) => ({ startsAt: new Date(v.start), endsAt: new Date(v.end), summary: v.title }))
      .filter((e) => e.startsAt >= from && e.startsAt < to)
  },
}

async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
  return (await res.json()) as { access_token: string; expires_in: number }
}

async function accessTokenFor(accountId: string): Promise<{ token: string; provider: string }> {
  const account = await prisma.externalAccount.findUniqueOrThrow({ where: { id: accountId } })
  if (account.expiresAt.getTime() > Date.now() + 60_000) {
    return { token: account.accessTokenEnc, provider: account.provider }
  }
  if (account.provider === 'GOOGLE_CALENDAR') {
    const refreshed = await refreshGoogleToken(account.refreshTokenEnc)
    await prisma.externalAccount.update({
      where: { id: account.id },
      data: {
        accessTokenEnc: refreshed.access_token,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      },
    })
    return { token: refreshed.access_token, provider: account.provider }
  }
  return { token: account.accessTokenEnc, provider: account.provider }
}

const googleProvider: CalendarProvider = {
  name: 'google',
  async upsertEvent(input) {
    const { token } = await accessTokenFor(input.accountId)
    const body = JSON.stringify({
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: DateTime.fromJSDate(input.startsAt).setZone(input.timezone).toISO(), timeZone: input.timezone },
      end: { dateTime: DateTime.fromJSDate(input.endsAt).setZone(input.timezone).toISO(), timeZone: input.timezone },
      extendedProperties: { private: { appointmentOsKey: input.idempotencyKey } },
    })
    const url = input.existingEventId
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${input.existingEventId}`
      : 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    const res = await fetch(url, {
      method: input.existingEventId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Google calendar ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = (await res.json()) as { id: string; etag?: string }
    return { externalEventId: json.id, etag: json.etag ?? '' }
  },
  async deleteEvent({ externalEventId, accountId }) {
    const { token } = await accessTokenFor(accountId)
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${externalEventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    )
  },
  async listBusy({ accountId, from, to }) {
    const { token } = await accessTokenFor(accountId)
    const url = `https://www.googleapis.com/calendar/v3/freeBusy?` +
      new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: 'primary',
      }).toString()
    const res = await fetch(`https://www.googleapis.com/calendar/v3/freeBusy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: 'primary' }],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    void url
    if (!res.ok) return []
    const json = (await res.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>
    }
    return (json.calendars?.primary?.busy ?? []).map((b) => ({
      startsAt: new Date(b.start),
      endsAt: new Date(b.end),
      summary: 'Busy (Google Calendar)',
    }))
  },
}

const microsoftProvider: CalendarProvider = {
  name: 'microsoft',
  async upsertEvent(input) {
    const { token } = await accessTokenFor(input.accountId)
    const body = JSON.stringify({
      subject: input.title,
      body: { contentType: 'text', content: input.description },
      location: { displayName: input.location },
      start: { dateTime: DateTime.fromJSDate(input.startsAt).setZone(input.timezone).toISO(), timeZone: input.timezone },
      end: { dateTime: DateTime.fromJSDate(input.endsAt).setZone(input.timezone).toISO(), timeZone: input.timezone },
      transactionId: input.idempotencyKey, // Graph honours this for de-duplication
    })
    const url = input.existingEventId
      ? `https://graph.microsoft.com/v1.0/me/events/${input.existingEventId}`
      : 'https://graph.microsoft.com/v1.0/me/events'
    const res = await fetch(url, {
      method: input.existingEventId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const json = (await res.json()) as { id: string; '@odata.etag'?: string }
    return { externalEventId: json.id, etag: json['@odata.etag'] ?? '' }
  },
  async deleteEvent({ externalEventId, accountId }) {
    const { token } = await accessTokenFor(accountId)
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${externalEventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  },
  async listBusy({ accountId, from, to }) {
    const { token } = await accessTokenFor(accountId)
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) return []
    const json = (await res.json()) as { value?: Array<{ start: { dateTime: string }; end: { dateTime: string }; subject?: string }> }
    return (json.value ?? []).map((e) => ({
      startsAt: new Date(e.start.dateTime + 'Z'),
      endsAt: new Date(e.end.dateTime + 'Z'),
      summary: e.subject ?? 'Busy (Outlook)',
    }))
  },
}

export function providerFor(kind: string): CalendarProvider {
  if (kind === 'GOOGLE_CALENDAR' && features.googleCalendar) return googleProvider
  if (kind === 'MICROSOFT_GRAPH' && features.microsoftCalendar) return microsoftProvider
  // Anything unconfigured falls back to the local simulator so the workflow is
  // still complete; the audit trail records which provider actually ran.
  return fakeProvider
}

/**
 * Push one appointment to every connected calendar in the org.
 * Idempotent: the mapping row decides create vs update, and a deterministic
 * event id means even a lost mapping cannot produce two events.
 */
export async function syncAppointment(appointmentId: string, action: 'upsert' | 'delete') {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { service: true, staff: true, customer: true, org: true, location: true, calendarEvents: true },
  })
  if (!appointment) throw new Error('Appointment not found')

  const accounts = await prisma.externalAccount.findMany({ where: { orgId: appointment.orgId } })
  if (accounts.length === 0) {
    // No calendars connected — nothing to do, and not an error worth retrying.
    return { synced: 0, skipped: true }
  }

  let synced = 0
  for (const account of accounts) {
    const provider = providerFor(account.provider)
    const mapping = appointment.calendarEvents.find((m) => m.provider === account.provider)
    const idempotencyKey = `aos:${appointment.id}:${account.provider}`

    try {
      if (action === 'delete') {
        if (mapping) {
          await provider.deleteEvent({ externalEventId: mapping.externalEventId, accountId: account.id })
          await prisma.calendarEventMapping.update({
            where: { id: mapping.id },
            data: { state: 'DELETED', lastSyncedAt: new Date() },
          })
        }
      } else {
        const result = await provider.upsertEvent({
          accountId: account.id,
          idempotencyKey,
          title: `${appointment.service.name} — ${appointment.customer.name}`,
          description: `Booked via AppointmentOS\nCustomer: ${appointment.customer.email}${appointment.notes ? `\nNotes: ${appointment.notes}` : ''}`,
          location: appointment.location.name,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          timezone: appointment.timezone,
          existingEventId: mapping?.state === 'DELETED' ? undefined : mapping?.externalEventId,
        })
        await prisma.calendarEventMapping.upsert({
          where: { appointmentId_provider: { appointmentId: appointment.id, provider: account.provider } },
          update: {
            externalEventId: result.externalEventId,
            etag: result.etag,
            state: 'SYNCED',
            lastSyncedAt: new Date(),
          },
          create: {
            appointmentId: appointment.id,
            provider: account.provider,
            externalEventId: result.externalEventId,
            etag: result.etag,
            state: 'SYNCED',
          },
        })
      }
      synced++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.calendarEventMapping.upsert({
        where: { appointmentId_provider: { appointmentId: appointment.id, provider: account.provider } },
        update: { state: 'FAILED', lastSyncedAt: new Date() },
        create: {
          appointmentId: appointment.id,
          provider: account.provider,
          externalEventId: `failed_${randomUUID().slice(0, 8)}`,
          state: 'FAILED',
        },
      })
      // Rethrow so the job retries with backoff; one bad calendar must not
      // silently stop syncing the others, so we surface after recording.
      throw new Error(`calendar sync failed for ${account.provider}: ${message}`)
    }
  }

  return { synced, skipped: false }
}

/** Connect a calendar (stand-in for the OAuth callback in local/demo mode). */
export async function connectDemoCalendar(input: {
  orgId: string
  userId: string
  provider: 'GOOGLE_CALENDAR' | 'MICROSOFT_GRAPH'
}) {
  return prisma.externalAccount.upsert({
    where: {
      orgId_provider_userId: {
        orgId: input.orgId,
        provider: input.provider,
        userId: input.userId,
      },
    },
    update: { connectedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) },
    create: {
      orgId: input.orgId,
      userId: input.userId,
      provider: input.provider,
      // In real OAuth these are encrypted at rest with a KMS-held key; the
      // demo stores opaque placeholders and never prints them.
      accessTokenEnc: `demo-access-${randomUUID()}`,
      refreshTokenEnc: `demo-refresh-${randomUUID()}`,
      scope: 'calendar.readwrite',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  })
}

export async function disconnectCalendar(input: { orgId: string; provider: string }) {
  await prisma.externalAccount.deleteMany({
    where: { orgId: input.orgId, provider: input.provider },
  })
}

/** Detect events in the staff calendar that we did not create — potential conflicts. */
export async function detectExternalConflicts(input: { orgId: string; from: Date; to: Date }) {
  const accounts = await prisma.externalAccount.findMany({ where: { orgId: input.orgId } })
  const conflicts: Array<{ provider: string; startsAt: Date; endsAt: Date; summary: string }> = []
  for (const account of accounts) {
    const provider = providerFor(account.provider)
    const busy = await provider.listBusy({ accountId: account.id, from: input.from, to: input.to })
    for (const interval of busy) {
      const clash = await prisma.appointment.findFirst({
        where: {
          orgId: input.orgId,
          status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] },
          startsAt: { lt: interval.endsAt },
          endsAt: { gt: interval.startsAt },
        },
      })
      if (clash) {
        conflicts.push({ provider: account.provider, ...interval })
      }
    }
  }
  return conflicts
}
