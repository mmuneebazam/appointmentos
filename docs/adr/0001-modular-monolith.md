# ADR 0001 — Ship a modular monolith, not microservices

- **Status:** accepted
- **Date:** 2026-10-24
- **Deciders:** Waleed Muneeb

## Context

AppointmentOS has three workloads with genuinely different shapes:

| Workload | Shape | Pressure |
| --- | --- | --- |
| Availability + booking | short, transactional, correctness-critical | read-heavy, latency-sensitive |
| Notifications + calendar sync | long, flaky, third-party | throughput, retries |
| Reporting | aggregate-heavy | bursty, tolerant of staleness |

The tempting response is three services. But the strongest requirement in this
product is **a consistent view across all three**: a booking, its occupancy
ticks, its payment intent, its audit entry and its queued reminder must be
committed together or not at all. Distributing that across service boundaries
would replace one database transaction with a saga, outbox, and compensating
actions — a large amount of machinery whose failure modes are harder to prove
than the ones it fixes.

## Decision

Build **one Next.js application plus one worker process**, sharing one database.

- Domain boundaries are enforced by module (`src/server/*`) and by function
  signatures: HTTP route handlers may call services, services do not know about
  `Request`/`Response`, and pure logic (`src/lib`) knows about neither.
- The worker is a **separate OS process** from day one, even though it shares the
  codebase. This is the one boundary worth paying for early: it isolates slow,
  retry-prone I/O from request latency, and it means extraction later is a
  deployment change rather than a refactor.
- Third-party I/O is always behind an adapter (`src/server/integrations/*`) with a
  local simulator, so the entire system is testable and demoable offline.

## Consequences

**Good**

- One `npm run dev` and one `npm run worker` runs everything.
- Booking, occupancy, audit and the enqueued notification commit atomically.
- Tests are integration tests against a real database, not mocks of HTTP hops.
- A reviewer can read the whole system in an afternoon.

**Bad**

- The web app and the worker scale together at the deployment level (they are
  separate processes, but one image).
- Nothing physically prevents a module from importing another's internals; the
  boundary is discipline plus code review. (A lint rule on import paths is the
  obvious next step.)
- Long report queries can contend with booking writes on SQLite; Postgres with a
  read replica is the production answer.

## Alternatives considered

1. **Three services with an event bus.** Rejected: correctness spans all three,
   and the saga/outbox machinery would dominate the codebase without adding
   demonstrable product value at this scale.
2. **Single process, worker inside the web app.** Rejected: long jobs would
   either block request handling or need a second scheduler inside a request
   cycle, and neither survives a deploy mid-job well.
3. **Serverless functions per endpoint.** Rejected: the scheduling guarantees
   lean on database transactions and index-level arbitration; per-invocation
   connection pools and cold starts make that harder to reason about, not easier.
