# ADR 0002 — Make the database arbitrate double bookings

- **Status:** accepted
- **Date:** 2026-10-24
- **Deciders:** Waleed Muneeb

## Context

Double booking is the defining failure of this product. The naive shape is:

```ts
const free = await isSlotFree(staffId, startsAt)   // read
if (!free) throw new ConflictError()
await createAppointment(...)                       // write
```

Between the read and the write, another request can do the same thing. Both see
the slot as free, both insert, and the calendar now has two patients at 09:00.
The window is a few milliseconds wide, which means it will not appear in manual
testing and will appear exactly once in production — on the busiest day.

Two browsers holding the same stale availability grid are the same bug with a
much wider window (minutes, not milliseconds).

## Decision

**Record occupancy as data and let a unique index arbitrate.**

Every appointment (and every hold) writes one `SlotLock` row per 15-minute tick
it covers:

```
block start = startsAt − bufferBefore
block end   = endsAt   + bufferAfter
ticks       = every quarter hour in [block start, block end)
```

`SlotLock(staffId, tickAt)` is `UNIQUE`. Overlapping requests collide on at
least one tick, even when their start times differ:

```
Consult 09:00–10:00 + 15m buffer  → ticks 09:00 09:15 09:30 09:45 10:00 10:15
Another booking at 10:30          → ticks 10:30 …            (no collision: fine)
A 30-min follow-up at 09:30       → ticks 09:30 09:45        (collision: rejected)
```

Supporting rules:

1. Ticks are written **in the same transaction** as the appointment, so a
   rollback cannot leak occupancy and a commit cannot omit it.
2. The availability engine **re-runs inside the transaction** before insert. The
   customer's grid is a hint; the engine plus the index are the authority.
3. Holds own their own ticks, so a hold is protected by exactly the same
   mechanism as a booking. Converting a hold to a booking re-points the ticks
   (`holdId → appointmentId`) instead of inserting a second set.
4. A `P2002` unique violation is translated into a 409 with a specific reason
   (`slot_taken`), never a 500.
5. Cancelling or rescheduling **deletes stale ticks** explicitly, so a freed slot
   is immediately bookable.

## Consequences

**Good**

- Correctness is a property of the schema, so it holds for every code path,
  including ones written later by someone who never read `booking.ts`.
- No global lock, no serializable isolation needed for the common path, no
  distributed lock service.
- The same mechanism protects holds, which is where the widest race window lives.

**Bad**

- 4–6 extra rows per booking. Trivial in absolute terms, but it is denormalised
  occupancy data that must be maintained whenever block times change.
- The 15-minute granularity means **bookings must be aligned to quarter hours**.
  Arbitrary start times (e.g. 09:07) would need a finer tick or the Postgres
  approach below.
- Deleting ticks is a write that must not be forgotten in new cancellation paths;
  the worker also sweeps expired holds as a backstop.

## Production path (Postgres)

Replace the tick table with a range exclusion constraint:

```sql
ALTER TABLE "Appointment" ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (
    "staffId" WITH =,
    tstzrange("blockStartsAt", "blockEndsAt", '[)') WITH &&
  ) WHERE (status IN ('CONFIRMED', 'PENDING_PAYMENT', 'COMPLETED'));
```

This expresses the invariant exactly (any overlap, any granularity) in one line
and removes the tick-maintenance burden. The application code does not change:
both approaches fail the insert, and `booking.ts` already translates that
failure into a 409.

## Alternatives considered

1. **`SELECT … FOR UPDATE` on the staff row, then check and insert.** Works, but
   serialises every booking for a staff member (including non-overlapping ones)
   and requires row-lock discipline in every call site.
2. **Serializable isolation with automatic retry.** Correct, but retries under
   contention are expensive and the failure is invisible in tests that do not run
   concurrently.
3. **Advisory locks keyed on staff + hour.** Fragile at hour boundaries and does
   not generalise to arbitrary durations.
4. **Trust the availability grid.** This is the bug, not the fix.
