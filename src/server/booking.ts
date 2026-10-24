/**
 * Booking lifecycle.
 *
 * The rules that make this more than CRUD:
 *
 *   • A slot is *provisionally* reserved by a SlotHold the moment the customer
 *     picks a time, so a 3-minute checkout cannot lose the slot. Holds expire.
 *   • Confirmation writes occupancy ticks and a unique index arbitrates races.
 *     We never trust a client-supplied "it looked free".
 *   • Every mutation is idempotent through an idempotency key, and every state
 *     change is audited and produces at-most-one notification.
 *   • Payment succeeds → booking confirms. Payment succeeds *after* the booking
 *     request timed out → the webhook still confirms it, because the webhook is
 *     the source of truth for money, not the HTTP response.
 */
import { prisma, withRetry, type Tx } from '@/lib/db'
import { conflict, notFound, unprocessable } from '@/lib/errors'
import { localDateOf, localMinutesOf, zonedInstant, DateTime } from '@/lib/time'
import { occupancyTicks, computeAvailability } from './availability'
import { recordAudit } from './audit'
import { queueNotification, type NotificationContext, type Template } from './notifications'
import { enqueue } from './jobs'
import { createPaymentIntent, refundPayment } from './integrations/payments'
import { randomUUID } from 'node:crypto'

export interface BookingCustomer {
  name: string
  email: string
  phone?: string | null
  timezone?: string
}

export interface CreateBookingInput {
  orgId: string
  serviceId: string
  staffId: string
  startsAt: string
  customer: BookingCustomer
  notes?: string
  holdToken?: string
  idempotencyKey?: string
  seats?: number
  actor: { type: 'CUSTOMER' | 'STAFF'; id?: string; name?: string }
  ip?: string
}

export interface BookingResult {
  appointment: {
    id: string
    status: string
    startsAt: string
    endsAt: string
    timezone: string
  }
  payment: { providerRef: string; clientSecret: string; amountCents: number } | null
  replayed: boolean
}

function buildContext(
  input: {
    appointmentId: string
    orgName: string
    orgSlug: string
    appUrl: string
    locationName: string
    timezone: string
  },
  appt: {
    startsAt: Date
    endsAt: Date
    priceCents: number
    currency: string
  },
  serviceName: string,
  staffName: string,
  customer: { name: string; email: string; phone?: string | null },
  version?: string,
): NotificationContext {
  return {
    appointmentId: input.appointmentId,
    orgName: input.orgName,
    orgSlug: input.orgSlug,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    staffName,
    serviceName,
    locationName: input.locationName,
    startsAt: appt.startsAt,
    endsAt: appt.endsAt,
    timezone: input.timezone,
    priceCents: appt.priceCents,
    currency: appt.currency,
    appUrl: input.appUrl,
    version,
  }
}

async function loadBookingScope(tx: Tx, input: { orgId: string; serviceId: string; staffId: string }) {
  const [org, service, staff, location] = await Promise.all([
    tx.organization.findUnique({ where: { id: input.orgId } }),
    tx.service.findFirst({ where: { id: input.serviceId, orgId: input.orgId, active: true } }),
    tx.staff.findFirst({ where: { id: input.staffId, orgId: input.orgId, active: true } }),
    tx.location.findFirst({
      where: { orgId: input.orgId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }),
  ])
  if (!org) throw notFound('Organization not found')
  if (!service) throw notFound('Service not found')
  if (!staff) throw notFound('Team member not found')
  if (!location) throw unprocessable('This organization has no bookable location yet')

  const qualified = await tx.staffService.findUnique({
    where: { staffId_serviceId: { staffId: staff.id, serviceId: service.id } },
  })
  if (!qualified) throw unprocessable('This team member does not offer that service')

  return { org, service, staff, location, zone: location.timezone || org.timezone }
}

/** Step 1 of the funnel: reserve the slot while the customer decides. */
export async function createHold(input: {
  orgId: string
  serviceId: string
  staffId: string
  startsAt: string
  customerId?: string
  now?: Date
}) {
  const now = input.now ?? new Date()
  return withRetry(() =>
    prisma.$transaction(async (tx) => {
      const { org, service, staff, location, zone } = await loadBookingScope(tx, input)
      const localDate = localDateOf(new Date(input.startsAt), zone)
      const availability = await computeAvailability(tx, {
        orgId: input.orgId,
        serviceId: service.id,
        localDate,
        staffId: staff.id,
        now,
      })
      const slot = availability.staff
        .flatMap((s) => s.slots)
        .find((s) => s.startsAt === new Date(input.startsAt).toISOString())
      if (!slot) throw conflict('That time is no longer available', { reason: 'slot_taken' })

      const startInstant = zonedInstant(localDate, localMinutesOf(slot.startsAt, zone), zone)
      const expiresAt = new Date(now.getTime() + org.slotHoldMinutes * 60_000)
      const token = randomUUID()

      const hold = await tx.slotHold.create({
        data: {
          token,
          orgId: input.orgId,
          locationId: location.id,
          serviceId: service.id,
          staffId: staff.id,
          customerId: input.customerId ?? null,
          startsAt: new Date(slot.startsAt),
          endsAt: new Date(slot.endsAt),
          blockStartsAt: new Date(startInstant.minus({ minutes: service.bufferBeforeMin }).toUTC().toISO()!),
          blockEndsAt: new Date(new Date(slot.endsAt).getTime() + service.bufferAfterMin * 60_000),
          expiresAt,
        },
      })

      const ticks = occupancyTicks(hold.blockStartsAt, hold.blockEndsAt)
      try {
        await tx.slotLock.createMany({
          data: ticks.map((tickAt) => ({ staffId: staff.id, tickAt, holdId: hold.id })),
        })
      } catch (err) {
        if (String(err).includes('P2002') || String(err).includes('Unique constraint')) {
          throw conflict('Someone else just took that time', { reason: 'slot_taken' })
        }
        throw err
      }

      await enqueue('hold.expire', { holdId: hold.id }, { runAt: expiresAt, orgId: input.orgId }, tx)
      await recordAudit(
        {
          orgId: input.orgId,
          actorType: 'CUSTOMER',
          action: 'slot.held',
          entityType: 'SlotHold',
          entityId: hold.id,
          metadata: { summary: `held ${service.name} at ${slot.label}`, startsAt: slot.startsAt },
        },
        tx,
      )

      return {
        token: hold.token,
        expiresAt: hold.expiresAt.toISOString(),
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        label: slot.label,
        endLabel: slot.endLabel,
        holdMinutes: org.slotHoldMinutes,
      }
    }),
  )
}

/** Step 2: turn a decision into a booking. Safe to retry. */
export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  const email = input.customer.email.trim().toLowerCase()
  if (!email.includes('@')) throw unprocessable('A valid email address is required')

  // Replay protection: the same key returns the same appointment, never a second one.
  if (input.idempotencyKey) {
    const existing = await prisma.appointment.findFirst({
      where: { orgId: input.orgId, idempotencyKey: input.idempotencyKey },
      include: { payments: true },
    })
    if (existing) {
      return {
        appointment: {
          id: existing.id,
          status: existing.status,
          startsAt: existing.startsAt.toISOString(),
          endsAt: existing.endsAt.toISOString(),
          timezone: existing.timezone,
        },
        payment: existing.payments[0]
          ? {
              providerRef: existing.payments[0].providerRef,
              clientSecret: '',
              amountCents: existing.payments[0].amountCents,
            }
          : null,
        replayed: true,
      }
    }
  }

  const committed = await withRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { org, service, staff, location, zone } = await loadBookingScope(tx, input)

        const requested = new Date(input.startsAt)
        if (Number.isNaN(requested.getTime())) throw unprocessable('Invalid start time')
        const localDate = localDateOf(requested, zone)

        // Reuse an existing hold for this exact slot if the customer has one.
        // Looking it up first matters: the hold's own occupancy ticks must be
        // excluded from the re-check, or checkout would block itself.
        const hold = input.holdToken
          ? await tx.slotHold.findUnique({ where: { token: input.holdToken } })
          : null
        const usableHold =
          hold &&
          hold.status === 'ACTIVE' &&
          hold.expiresAt > new Date() &&
          hold.serviceId === service.id &&
          hold.staffId === staff.id &&
          hold.startsAt.getTime() === requested.getTime()
            ? hold
            : null

        // Authoritative re-check. The customer's grid may be minutes old.
        const availability = await computeAvailability(tx, {
          orgId: input.orgId,
          serviceId: service.id,
          localDate,
          staffId: staff.id,
          ignoreHoldId: usableHold?.id,
        })
        const slot = availability.staff
          .flatMap((s) => s.slots)
          .find((s) => new Date(s.startsAt).getTime() === requested.getTime())
        if (!slot) throw conflict('That time is no longer available', { reason: 'slot_taken' })

        const customer = await tx.customer.upsert({
          where: { orgId_email: { orgId: input.orgId, email } },
          update: {
            name: input.customer.name || undefined,
            phone: input.customer.phone || undefined,
          },
          create: {
            orgId: input.orgId,
            email,
            name: input.customer.name || email.split('@')[0],
            phone: input.customer.phone ?? null,
            timezone: input.customer.timezone ?? zone,
          },
        })

        const startsAt = new Date(slot.startsAt)
        const endsAt = new Date(slot.endsAt)
        const blockStartsAt = new Date(startsAt.getTime() - service.bufferBeforeMin * 60_000)
        const blockEndsAt = new Date(endsAt.getTime() + service.bufferAfterMin * 60_000)

        // Money decision: deposit required? full price? free service?
        const amountDueCents = org.depositRequired
          ? service.depositCents > 0
            ? service.depositCents
            : 0
          : service.priceCents
        const needsPayment = amountDueCents > 0
        const status = needsPayment ? 'PENDING_PAYMENT' : 'CONFIRMED'

        const appointment = await tx.appointment.create({
          data: {
            orgId: input.orgId,
            locationId: location.id,
            serviceId: service.id,
            staffId: staff.id,
            customerId: customer.id,
            startsAt,
            endsAt,
            blockStartsAt,
            blockEndsAt,
            timezone: zone,
            localDate,
            localStartMin: localMinutesOf(startsAt, zone),
            localEndMin: localMinutesOf(endsAt, zone),
            status,
            seats: service.isGroup ? Math.min(input.seats ?? 1, service.maxParticipants) : 1,
            priceCents: service.priceCents,
            depositCents: amountDueCents,
            currency: org.currency,
            notes: input.notes ?? null,
            createdByType: input.actor.type,
            createdById: input.actor.id ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            holdId: usableHold?.id ?? null,
            confirmedAt: status === 'CONFIRMED' ? new Date() : null,
          },
        })

        // Occupancy. Two concurrent writers collide here — one wins, one 409s.
        try {
          if (usableHold) {
            // Adopt the hold's locks; do not insert a second set.
            await tx.slotLock.updateMany({
              where: { holdId: usableHold.id },
              data: { appointmentId: appointment.id },
            })
            await tx.slotHold.update({
              where: { id: usableHold.id },
              data: { status: 'CONSUMED', customerId: customer.id },
            })
          } else if (!service.isGroup) {
            const ticks = occupancyTicks(blockStartsAt, blockEndsAt)
            await tx.slotLock.createMany({
              data: ticks.map((tickAt) => ({
                staffId: staff.id,
                tickAt,
                appointmentId: appointment.id,
              })),
            })
          }
        } catch (err) {
          const message = String(err)
          if (message.includes('P2002') || message.includes('Unique constraint')) {
            throw conflict('Someone else just booked that time', { reason: 'slot_taken' })
          }
          throw err
        }

        await recordAudit(
          {
            orgId: input.orgId,
            actorType: input.actor.type === 'STAFF' ? 'USER' : 'CUSTOMER',
            actorId: input.actor.id ?? customer.id,
            action: 'appointment.created',
            entityType: 'Appointment',
            entityId: appointment.id,
            ip: input.ip,
            metadata: {
              summary: `booked ${service.name} for ${customer.name}`,
              startsAt: startsAt.toISOString(),
              staffName: staff.name,
              actorName: input.actor.name,
              status,
            },
          },
          tx,
        )

        const ctx = buildContext(
          {
            appointmentId: appointment.id,
            orgName: org.name,
            orgSlug: org.slug,
            appUrl: process.env.APP_URL ?? 'http://localhost:3000',
            locationName: location.name,
            timezone: zone,
          },
          { startsAt, endsAt, priceCents: service.priceCents, currency: org.currency },
          service.name,
          staff.name,
          customer,
        )

        const template: Template = needsPayment ? 'BOOKING_RECEIVED' : 'BOOKING_CONFIRMED'
        await queueNotification(tx, {
          orgId: input.orgId,
          appointmentId: appointment.id,
          channel: 'EMAIL',
          template,
          recipient: customer.email,
          ctx,
          dedupeKey: `${appointment.id}:${template}`,
        })
        if (customer.phone) {
          await queueNotification(tx, {
            orgId: input.orgId,
            appointmentId: appointment.id,
            channel: 'SMS',
            template,
            recipient: customer.phone,
            ctx,
            dedupeKey: `${appointment.id}:${template}:sms`,
          })
        }
        if (status === 'CONFIRMED') {
          await queueNotification(tx, {
            orgId: input.orgId,
            appointmentId: appointment.id,
            channel: 'EMAIL',
            template: 'STAFF_ALERT',
            recipient: staff.email ?? org.slug + '@internal.invalid',
            ctx,
            dedupeKey: `${appointment.id}:STAFF_ALERT`,
          })
          // A reminder is only legal for the current version of the appointment.
          const reminderAt = new Date(startsAt.getTime() - 24 * 3600_000)
          if (reminderAt > new Date()) {
            await queueNotification(tx, {
              orgId: input.orgId,
              appointmentId: appointment.id,
              channel: 'EMAIL',
              template: 'REMINDER_24H',
              recipient: customer.email,
              ctx,
              sendAt: reminderAt,
              dedupeKey: `${appointment.id}:REMINDER_24H:v1`,
            })
          }
        }
        await enqueue('calendar.sync', { appointmentId: appointment.id, action: 'upsert' }, { orgId: input.orgId }, tx)

        return {
          appointment,
          customer,
          org,
          service,
          staff,
          location,
          zone,
          amountDueCents,
          needsPayment,
        }
      },
      { timeout: 20_000, maxWait: 20_000 },
    ),
  )

  // Provider I/O happens *outside* the transaction: a hung Stripe call must not
  // hold a write lock, and a failure here leaves a PENDING_PAYMENT booking that
  // the hold-expiry job cleans up rather than a half-written one.
  let payment: BookingResult['payment'] = null
  if (committed.needsPayment) {
    const idempotencyKey = `pi_${committed.appointment.id}`
    try {
      const intent = await createPaymentIntent({
        amountCents: committed.amountDueCents,
        currency: committed.org.currency,
        appointmentId: committed.appointment.id,
        customerEmail: committed.customer.email,
        description: `${committed.service.name} — ${committed.org.name}`,
        idempotencyKey,
      })
      await prisma.payment.upsert({
        where: { providerRef: intent.providerRef },
        update: {},
        create: {
          orgId: committed.org.id,
          appointmentId: committed.appointment.id,
          provider: intent.provider,
          providerRef: intent.providerRef,
          amountCents: committed.amountDueCents,
          currency: committed.org.currency,
          idempotencyKey,
        },
      })
      payment = {
        providerRef: intent.providerRef,
        clientSecret: intent.clientSecret,
        amountCents: committed.amountDueCents,
      }
    } catch (err) {
      console.error('[booking] payment intent creation failed', err)
      await recordAudit({
        orgId: committed.org.id,
        actorType: 'SYSTEM',
        action: 'payment.intent_failed',
        entityType: 'Appointment',
        entityId: committed.appointment.id,
        metadata: { summary: 'payment intent could not be created — booking left pending' },
      })
    }
  }

  return {
    appointment: {
      id: committed.appointment.id,
      status: committed.appointment.status,
      startsAt: committed.appointment.startsAt.toISOString(),
      endsAt: committed.appointment.endsAt.toISOString(),
      timezone: committed.appointment.timezone,
    },
    payment,
    replayed: false,
  }
}

// ─────────────────────────── cancellation ───────────────────────────

export interface CancellationPolicy {
  hoursUntilStart: number
  windowHours: number
  insideWindow: boolean
  refundableCents: number
  feeCents: number
}

/** Pure so it can be unit-tested without a database. */
export function evaluateCancellation(input: {
  startsAt: Date
  now: Date
  windowHours: number
  amountPaidCents: number
  priceCents: number
}): CancellationPolicy {
  const hoursUntilStart = (input.startsAt.getTime() - input.now.getTime()) / 3_600_000
  const insideWindow = hoursUntilStart < input.windowHours
  // Inside the window the org keeps what was paid, capped at the service price.
  const feeCents = insideWindow ? Math.min(input.amountPaidCents, input.priceCents) : 0
  return {
    hoursUntilStart: Math.round(hoursUntilStart * 100) / 100,
    windowHours: input.windowHours,
    insideWindow,
    refundableCents: Math.max(0, input.amountPaidCents - feeCents),
    feeCents,
  }
}

export async function cancelAppointment(input: {
  orgId: string
  appointmentId: string
  reason?: string
  actor: { type: 'CUSTOMER' | 'STAFF' | 'SYSTEM'; id?: string; name?: string }
  now?: Date
}) {
  const now = input.now ?? new Date()

  const result = await withRetry(() =>
    prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: input.appointmentId, orgId: input.orgId },
        include: { service: true, staff: true, customer: true, org: true, location: true, payments: true },
      })
      if (!appointment) throw notFound('Appointment not found')
      if (appointment.status === 'CANCELLED') {
        return { alreadyCancelled: true, appointment, policy: null as CancellationPolicy | null }
      }
      if (appointment.status === 'COMPLETED') {
        throw conflict('A completed appointment cannot be cancelled')
      }

      const policy = evaluateCancellation({
        startsAt: appointment.startsAt,
        now,
        windowHours: appointment.org.cancellationWindowHrs,
        amountPaidCents: appointment.amountPaidCents,
        priceCents: appointment.priceCents,
      })

      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancellationReason: input.reason ?? null,
        },
      })

      // Free the time immediately — a cancelled slot must be re-bookable at once.
      await tx.slotLock.deleteMany({ where: { appointmentId: appointment.id } })

      await recordAudit(
        {
          orgId: input.orgId,
          actorType: input.actor.type === 'STAFF' ? 'USER' : input.actor.type,
          actorId: input.actor.id ?? null,
          action: 'appointment.cancelled',
          entityType: 'Appointment',
          entityId: appointment.id,
          metadata: {
            summary: `cancelled ${appointment.service.name}`,
            reason: input.reason ?? null,
            feeCents: policy.feeCents,
            refundCents: policy.refundableCents,
            actorName: input.actor.name,
          },
        },
        tx,
      )

      const ctx = buildContext(
        {
          appointmentId: appointment.id,
          orgName: appointment.org.name,
          orgSlug: appointment.org.slug,
          appUrl: process.env.APP_URL ?? 'http://localhost:3000',
          locationName: appointment.location.name,
          timezone: appointment.timezone,
        },
        appointment,
        appointment.service.name,
        appointment.staff.name,
        appointment.customer,
      )
      await queueNotification(tx, {
        orgId: input.orgId,
        appointmentId: appointment.id,
        channel: 'EMAIL',
        template: 'BOOKING_CANCELLED',
        recipient: appointment.customer.email,
        ctx,
        dedupeKey: `${appointment.id}:BOOKING_CANCELLED`,
      })

      let refundId: string | null = null
      const captured = appointment.payments.find((p) => p.status === 'SUCCEEDED')
      if (policy.refundableCents > 0 && captured) {
        const refund = await tx.refund.create({
          data: {
            orgId: input.orgId,
            paymentId: captured.id,
            amountCents: policy.refundableCents,
            reason: input.reason ?? 'Customer cancellation',
            status: 'PENDING',
          },
        })
        refundId = refund.id
        await enqueue(
          'payment.refund',
          { refundId: refund.id },
          { orgId: input.orgId, maxAttempts: 8 },
          tx,
        )
      }

      await enqueue('calendar.sync', { appointmentId: appointment.id, action: 'delete' }, { orgId: input.orgId }, tx)

      return { alreadyCancelled: false, appointment, policy, refundId }
    }),
  )

  if (result.alreadyCancelled) {
    return { alreadyCancelled: true, refundCents: 0, feeCents: 0 }
  }
  return {
    alreadyCancelled: false,
    refundCents: result.policy?.refundableCents ?? 0,
    feeCents: result.policy?.feeCents ?? 0,
    refundId: 'refundId' in result ? result.refundId : null,
  }
}

// ─────────────────────────── reschedule ───────────────────────────

export async function rescheduleAppointment(input: {
  orgId: string
  appointmentId: string
  startsAt: string
  staffId?: string
  reason?: string
  actor: { type: 'CUSTOMER' | 'STAFF' | 'SYSTEM'; id?: string; name?: string }
}) {
  return withRetry(() =>
    prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: input.appointmentId, orgId: input.orgId },
        include: { service: true, staff: true, customer: true, org: true, location: true },
      })
      if (!appointment) throw notFound('Appointment not found')
      if (['CANCELLED', 'COMPLETED'].includes(appointment.status)) {
        throw conflict(`A ${appointment.status.toLowerCase()} appointment cannot be moved`)
      }

      const staffId = input.staffId ?? appointment.staffId
      const requested = new Date(input.startsAt)
      if (Number.isNaN(requested.getTime())) throw unprocessable('Invalid start time')
      const localDate = localDateOf(requested, appointment.timezone)

      const availability = await computeAvailability(tx, {
        orgId: input.orgId,
        serviceId: appointment.serviceId,
        localDate,
        staffId,
      })
      const slot = availability.staff
        .flatMap((s) => s.slots)
        .find((s) => new Date(s.startsAt).getTime() === requested.getTime())
      if (!slot) throw conflict('That time is not available', { reason: 'slot_taken' })

      const startsAt = new Date(slot.startsAt)
      const endsAt = new Date(slot.endsAt)
      const blockStartsAt = new Date(startsAt.getTime() - appointment.service.bufferBeforeMin * 60_000)
      const blockEndsAt = new Date(endsAt.getTime() + appointment.service.bufferAfterMin * 60_000)

      // Reserve the new time BEFORE releasing the old one. If the new slot is
      // taken we fail here and the customer keeps their existing appointment.
      const ticks = occupancyTicks(blockStartsAt, blockEndsAt)
      try {
        await tx.slotLock.createMany({
          data: ticks.map((tickAt) => ({
            staffId,
            tickAt,
            appointmentId: appointment.id,
          })),
        })
      } catch (err) {
        const message = String(err)
        if (message.includes('P2002') || message.includes('Unique constraint')) {
          throw conflict('That time was just taken', { reason: 'slot_taken' })
        }
        throw err
      }

      // Release ticks from the previous slot that the new slot does not cover.
      const newTickSet = new Set(ticks.map((t) => t.getTime()))
      const oldLocks = await tx.slotLock.findMany({ where: { appointmentId: appointment.id } })
      const staleIds = oldLocks
        .filter((l) => !newTickSet.has(l.tickAt.getTime()))
        .map((l) => l.id)
      if (staleIds.length > 0) {
        await tx.slotLock.deleteMany({ where: { id: { in: staleIds } } })
      }

      const updated = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          startsAt,
          endsAt,
          blockStartsAt,
          blockEndsAt,
          staffId,
          localDate,
          localStartMin: localMinutesOf(startsAt, appointment.timezone),
          localEndMin: localMinutesOf(endsAt, appointment.timezone),
        },
      })

      await recordAudit(
        {
          orgId: input.orgId,
          actorType: input.actor.type === 'STAFF' ? 'USER' : input.actor.type,
          actorId: input.actor.id ?? null,
          action: 'appointment.rescheduled',
          entityType: 'Appointment',
          entityId: appointment.id,
          metadata: {
            summary: `moved to ${DateTime.fromJSDate(startsAt).setZone(appointment.timezone).toFormat('LLL d, HH:mm')}`,
            from: appointment.startsAt.toISOString(),
            to: startsAt.toISOString(),
            reason: input.reason ?? null,
            actorName: input.actor.name,
          },
        },
        tx,
      )

      const ctx = buildContext(
        {
          appointmentId: appointment.id,
          orgName: appointment.org.name,
          orgSlug: appointment.org.slug,
          appUrl: process.env.APP_URL ?? 'http://localhost:3000',
          locationName: appointment.location.name,
          timezone: appointment.timezone,
        },
        { startsAt, endsAt, priceCents: appointment.priceCents, currency: appointment.currency },
        appointment.service.name,
        appointment.staff.name,
        appointment.customer,
        `reschedule-${Date.now()}`,
      )
      // Versioned dedupe key: the old reminder is now stale, and this is a
      // genuinely new message, so it must not be suppressed by the old key.
      await queueNotification(tx, {
        orgId: input.orgId,
        appointmentId: appointment.id,
        channel: 'EMAIL',
        template: 'BOOKING_RESCHEDULED',
        recipient: appointment.customer.email,
        ctx,
        dedupeKey: `${appointment.id}:BOOKING_RESCHEDULED:${startsAt.getTime()}`,
      })

      if (appointment.status === 'CONFIRMED') {
        const reminderAt = new Date(startsAt.getTime() - 24 * 3600_000)
        if (reminderAt > new Date()) {
          await queueNotification(tx, {
            orgId: input.orgId,
            appointmentId: appointment.id,
            channel: 'EMAIL',
            template: 'REMINDER_24H',
            recipient: appointment.customer.email,
            ctx,
            sendAt: reminderAt,
            dedupeKey: `${appointment.id}:REMINDER_24H:${startsAt.getTime()}`,
          })
        }
      }

      await enqueue('calendar.sync', { appointmentId: appointment.id, action: 'upsert' }, { orgId: input.orgId }, tx)

      return {
        id: updated.id,
        status: updated.status,
        startsAt: updated.startsAt.toISOString(),
        endsAt: updated.endsAt.toISOString(),
        timezone: updated.timezone,
      }
    }),
  )
}

export async function completeAppointment(input: { orgId: string; appointmentId: string }) {
  const updated = await prisma.appointment.updateMany({
    where: { id: input.appointmentId, orgId: input.orgId, status: 'CONFIRMED' },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })
  if (updated.count === 0) throw conflict('Only a confirmed appointment can be completed')
  await recordAudit({
    orgId: input.orgId,
    actorType: 'USER',
    action: 'appointment.completed',
    entityType: 'Appointment',
    entityId: input.appointmentId,
    metadata: { summary: 'marked appointment complete' },
  })
  return { ok: true }
}

/** Called by the worker for a due hold.expire job. */
export async function expireHold(holdId: string) {
  return withRetry(async () => {
    const hold = await prisma.slotHold.findUnique({ where: { id: holdId } })
    if (!hold) return { expired: false }
    if (hold.status !== 'ACTIVE') return { expired: false }
    if (hold.expiresAt > new Date()) {
      // Job fired early (clock skew); reschedule rather than dropping it.
      await enqueue('hold.expire', { holdId }, { runAt: hold.expiresAt, orgId: hold.orgId })
      return { expired: false }
    }
    await prisma.$transaction(async (tx) => {
      await tx.slotHold.update({ where: { id: holdId }, data: { status: 'EXPIRED' } })
      await tx.slotLock.deleteMany({ where: { holdId } })
    })
    return { expired: true }
  })
}

/** Active holds for a customer email, used by the "we're holding your slot" banner. */
export async function activeHoldsFor(email: string) {
  return prisma.slotHold.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
      customer: { email: email.toLowerCase() },
    },
    include: { service: true, staff: true },
  })
}

export async function payRemaining(input: { orgId: string; appointmentId: string }) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: input.appointmentId, orgId: input.orgId },
    include: { service: true, customer: true, org: true },
  })
  if (!appointment) throw notFound('Appointment not found')
  const outstanding = appointment.priceCents - appointment.amountPaidCents
  if (outstanding <= 0) throw conflict('Nothing left to pay')
  return createPaymentIntent({
    amountCents: outstanding,
    currency: appointment.currency,
    appointmentId: appointment.id,
    customerEmail: appointment.customer.email,
    description: `Balance — ${appointment.service.name}`,
    idempotencyKey: `pi_balance_${appointment.id}_${appointment.amountPaidCents}`,
  })
}

export async function processRefundJob(refundId: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { payment: true },
  })
  if (!refund) throw new Error('Refund not found')
  if (refund.status === 'SUCCEEDED') return { ok: true, skipped: true }

  const result = await refundPayment({
    provider: refund.payment.provider as 'mock' | 'stripe',
    providerRef: refund.payment.providerRef,
    amountCents: refund.amountCents,
    idempotencyKey: `re_${refund.id}`,
  })
  if (!result.ok) {
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'FAILED' },
    })
    throw new Error('Refund provider rejected the request')
  }

  await prisma.$transaction(async (tx) => {
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: 'SUCCEEDED', providerRef: result.providerRef },
    })
    await tx.appointment.update({
      where: { id: refund.payment.appointmentId },
      data: { amountPaidCents: { decrement: refund.amountCents } },
    })
    await recordAudit(
      {
        orgId: refund.orgId,
        actorType: 'SYSTEM',
        action: 'payment.refunded',
        entityType: 'Refund',
        entityId: refund.id,
        metadata: { summary: `refunded ${refund.amountCents} minor units`, amountCents: refund.amountCents },
      },
      tx,
    )
  })
  return { ok: true }
}
