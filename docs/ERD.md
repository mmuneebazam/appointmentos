# Entity relationship overview

The full definition is `prisma/schema.prisma` (24 models). This document covers
the relationships and the constraints that carry correctness.

## Tenancy

```
User ──< Membership >── Organization ──< Location
                              │
                              ├──< Service ──< StaffService >── Staff ──< WorkingHours
                              │                                    │      └──< ScheduleException
                              ├──< Customer                        │
                              ├──< Appointment >───────────────────┘
                              ├──< Payment ──< Refund
                              ├──< Notification
                              ├──< WebhookEvent
                              ├──< AuditLog
                              ├──< Job
                              └──< ExternalAccount ──< CalendarEventMapping
```

Every child carries `orgId` (or reaches the organisation through a parent that
does). Reads and writes always filter on it — see `requireMembership()`.

## Scheduling core

```
Service            durationMin, bufferBeforeMin, bufferAfterMin, priceCents,
                   depositCents, isGroup, maxParticipants
WorkingHours       (staffId, weekday, startMin, endMin)   ← local clock, per weekday
ScheduleException  (staffId, date, kind ∈ LEAVE|HOLIDAY|EXTRA_HOURS, startMin?, endMin?)
Appointment        startsAt/endsAt (UTC) + blockStartsAt/blockEndsAt (UTC)
                   + timezone + localDate + localStartMin/localEndMin
SlotHold           token, startsAt, endsAt, block window, expiresAt, status
SlotLock           (staffId, tickAt) UNIQUE  → the double-booking guard
```

`blockStartsAt = startsAt − bufferBeforeMin`, `blockEndsAt = endsAt + bufferAfterMin`.
Occupancy is the set of quarter-hour ticks in that window, one `SlotLock` row
each, owned by either a hold or an appointment.

## Money

```
Payment   providerRef UNIQUE, idempotencyKey UNIQUE, amountCents Int,
          currency, status ∈ REQUIRES_PAYMENT|SUCCEEDED|FAILED|REFUNDED
Refund    paymentId, amountCents, status, providerRef
```

All amounts are integer **minor units**. No floating point is used for money
anywhere in the codebase (see `src/lib/money.ts`).

## Operations

```
Job              type, payload, status, attempts, maxAttempts, runAt,
                 lockToken, lockedAt, lastError
Notification     channel, template, recipient, payload, status, attempts,
                 sendAt, dedupeKey UNIQUE
WebhookEvent     (provider, externalId) UNIQUE, type, payload, status, attempts
AuditLog         actorType, actorId, action, entityType, entityId, metadata, ip
CalendarEventMapping  (appointmentId, provider) UNIQUE, externalEventId, state
```

## Constraints worth knowing

| Constraint | Why |
| --- | --- |
| `SlotLock (staffId, tickAt)` UNIQUE | two bookings can never overlap |
| `SlotHold.token` UNIQUE | holds are addressed by an unguessable token |
| `Notification.dedupeKey` UNIQUE | a retried job cannot send twice |
| `WebhookEvent (provider, externalId)` UNIQUE | replay protection |
| `Payment.providerRef`, `Payment.idempotencyKey` UNIQUE | no double charge |
| `Appointment (orgId, idempotencyKey)` UNIQUE | a double-submit returns the same booking |
| `Customer (orgId, email)` UNIQUE | one customer record per tenant |
| `StaffService (staffId, serviceId)` UNIQUE | qualification is explicit |
| `CalendarEventMapping (appointmentId, provider)` UNIQUE | one event per calendar per appointment |

## Indexes for the hot paths

```
Appointment (orgId, startsAt)   dashboard day/week queries
Appointment (staffId, startsAt) availability conflict scan
Appointment (orgId, status)     filtered lists and counts
SlotLock    (appointmentId), (holdId), (tickAt)
Job         (status, runAt)     queue claim
Notification(status, sendAt)    delivery sweep
```
