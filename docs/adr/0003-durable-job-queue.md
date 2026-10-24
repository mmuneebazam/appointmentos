# ADR 0003 — A database-backed durable queue with a BullMQ-shaped contract

- **Status:** accepted (revisit at scale)
- **Date:** 2026-10-24
- **Deciders:** Waleed Muneeb

## Context

Several things must not happen inside a request:

- sending confirmation/reminder email and SMS (slow, third-party, rate limited)
- writing to Google Calendar or Microsoft Graph (slow, can fail transiently)
- issuing refunds (must be retried, must never be double-issued)
- expiring slot holds (a timer, not a request)
- reprocessing a webhook whose payment row was not visible yet

The reliability properties we actually need are the ones BullMQ provides:
atomic claim, at-least-once delivery, exponential backoff with jitter,
concurrency control, and a dead-letter state that a human can inspect.

But the demo must also run with `npm install && npm run dev` — no Redis, no
Docker. And there is a second, quieter benefit to keeping jobs in the primary
database: **a job can be enqueued in the same transaction as the state change
that caused it**, so you cannot have a booking that was committed while its
reminder was lost.

## Decision

Implement the queue as a `Job` table behind the same interface BullMQ exposes.

```ts
enqueue(type, payload, { runAt, maxAttempts, orgId })   // transaction-aware
claimJobs(limit, lockToken)                             // atomic
completeJob / failJob                                   // backoff + dead-letter
```

Key mechanics:

- **Atomic claim.** `findMany` candidates, then a conditional
  `updateMany({ where: { id, status: 'QUEUED' } })` per candidate. Only the worker
  whose update affects one row owns the job. A plain read-then-update would let
  two workers take the same job.
- **Crash recovery.** A `RUNNING` job whose `lockedAt` is older than two minutes
  is reset to `QUEUED` on the next claim pass. The lock token prevents a zombie
  worker from completing a job that was re-claimed.
- **Backoff.** `min(cap, base · 2^attempt)` with full jitter, so a provider
  outage produces a spread retry pattern instead of a thundering herd.
- **Dead-letter.** After `maxAttempts`, status becomes `DEAD_LETTER` and
  `lastError` is preserved and surfaced on `/dashboard/operations`.
- **Handlers are idempotent.** At-least-once delivery is assumed. Notifications
  rely on a unique `dedupeKey`; calendar sync on deterministic event ids; refunds
  on the refund row's own state.

## Consequences

**Good**

- Zero extra infrastructure; the demo boots anywhere.
- Jobs are transactional with domain state.
- The queue is inspectable with SQL, which makes incident response trivial
  ("`SELECT * FROM Job WHERE status='DEAD_LETTER'`").
- Migrating to BullMQ/Redis means rewriting `src/server/jobs.ts` only; call sites
  do not change.

**Bad**

- Polling instead of a blocking pop: up to ~1s of latency, and idle queries.
- SQLite writes are serialised, so claim traffic contends with booking traffic
  (mitigated by small batches and short transactions).
- No built-in scheduling UI, job priorities, or rate-limit groups; the
  per-provider rate limiting in `integrations/*` is cooperative, not enforced by
  the queue.
- The in-process rate limiter is per-instance.

## Alternatives considered

1. **BullMQ + Redis from the start.** The right production answer for volume; it
   makes the project undeployable in a plain sandbox, which was a hard
   requirement here.
2. **`pg-boss` / `graphile-worker`.** Excellent Postgres-native options and very
   close in spirit — but they hide exactly the queue semantics this project is
   meant to demonstrate.
3. **In-process `setTimeout` / `cron`.** Loses work on restart, cannot retry, and
   cannot be inspected. Rejected immediately.
4. **Temporal.** Correct for FlowForge (project 02), whose workflows are
   long-lived and stateful. For a handful of short job types here it is a large
   operational commitment for little gain.
