# ADR 0004 — Store UTC instants, but never lose the local wall clock

- **Status:** accepted
- **Date:** 2026-10-24
- **Deciders:** Waleed Muneeb

## Context

Staff availability is a statement about the **local wall clock**: "I work
09:00–17:00 on Tuesdays." Customers expect "09:00" to mean 09:00 where the
appointment is, on the day it happens.

Two things routinely go wrong:

1. **Storing local times.** Fine until a timezone changes its offset, at which
   point historical appointments silently shift.
2. **Adding 24 hours repeatedly.** A recurring rule evaluated in UTC drifts by an
   hour across every daylight-saving transition. In `America/New_York`, a naive
   weekly 09:00 series becomes 08:00 for half the year.

There are also two genuinely ambiguous cases on transition days:

- **Spring forward:** 02:00–03:00 does not exist. An appointment "at 02:30" has
  no instant.
- **Fall back:** 01:00–02:00 happens twice. "At 01:30" has two instants.

## Decision

**Dual representation, with the local intent explicit.**

```prisma
startsAt      DateTime   // UTC instant — the truth for ordering and arithmetic
endsAt        DateTime
timezone      String     // the zone the appointment was booked in
localDate     String     // "2026-03-08"
localStartMin Int        // minutes from local midnight
localEndMin   Int
```

Rules:

1. Every instant crossing the API boundary is ISO-8601 UTC. Client code never
   does timezone arithmetic.
2. Recurring availability is stored as **minutes from local midnight per weekday**
   (`WorkingHours.weekday/startMin/endMin`) and resolved **per local date**, not
   by stepping through UTC.
3. `zonedInstant(date, minutes, zone)` builds candidate starts. The resolved
   wall clock is compared back to the requested minutes: if they differ, the time
   fell in a **DST gap** and the slot is **skipped** (`availability.ts`).
4. DST overlaps resolve deterministically to the **first** occurrence, because
   this is a scheduling product where "earlier" is the intuitive default.
5. UI formatting always takes an explicit zone (`formatTime(instant, zone)`);
   there is no ambient server timezone in any render path.
6. A cancelled-then-rebooked or rescheduled appointment keeps its own
   `timezone`, so changing the organisation default later does not rewrite
   history.

## Consequences

**Good**

- "09:00" means 09:00 in the location, every day of the year.
- A time-change weekend produces *fewer* slots (skipped gap) rather than a
  corrupt one.
- Reporting windows ("today", "last 30 days") are computed in the org's zone, so
  a late-evening booking is counted on the day staff actually worked.
- Tests pin the specific transitions (`2026-03-08`, `2026-11-01`).

**Bad**

- Two sources of truth for "when", which must not be allowed to disagree. The
  local fields are written only by the booking service, from the same instant.
- Historical display uses the *booking* zone, which can differ from the org's
  current zone. Correct, but occasionally surprising ("why does this show 09:00
  when we're now in Europe?").
- 15-minute tick occupancy is aligned to fixed quarter hours in UTC; in zones
  with :30 or :45 offsets the tick grid is offset accordingly rather than aligned
  to local clock notation. Acceptable because candidates are always generated on
  local-clock boundaries.

## Alternatives considered

1. **Store only UTC and reconstruct wall clock on read.** Loses the intent when a
   zone's rules change, and cannot distinguish the two 01:30s.
2. **Store local times only (`timestamp without time zone`).** Breaks ordering
   across zones and makes "starts in 30 minutes" impossible to compute reliably.
3. **Store a timezone per appointment and nothing else.** Requires re-deriving
   minutes-on-the-day for every query; error-prone and slower.
4. **Fix the whole product to UTC.** Unacceptable for a real booking business:
   staff in New York would see their 09:00 shift as 13:00.
