/**
 * Durable job queue.
 *
 * Contract mirrors BullMQ so the migration is a swap, not a rewrite:
 *   • enqueue(type, payload, { runAt, maxAttempts, orgId })
 *   • claim a batch atomically (no two workers may take the same job)
 *   • exponential backoff with jitter on failure
 *   • dead-letter after maxAttempts, never silently dropped
 *
 * The critical property for this product is *at-least-once with deduplication*:
 * a job may run twice after a crash, so every handler must be idempotent. The
 * notification table enforces that with a unique dedupeKey rather than relying
 * on the queue to be perfect.
 */
import { prisma, withRetry, type Tx } from '@/lib/db'

export type JobType =
  | 'notification.send'
  | 'hold.expire'
  | 'reminder.scan'
  | 'calendar.sync'
  | 'appointment.complete'
  | 'webhook.process'
  | 'payment.refund'

export interface EnqueueOptions {
  runAt?: Date
  maxAttempts?: number
  orgId?: string | null
}

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
  db: Tx | typeof prisma = prisma,
): Promise<string> {
  const job = await db.job.create({
    data: {
      type,
      payload: JSON.stringify(payload),
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
      orgId: opts.orgId ?? null,
    },
  })
  return job.id
}

/** Delay in ms before attempt N (0-indexed), with full jitter to avoid thundering herds. */
export function backoffMs(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.round(exponential / 2 + Math.random() * (exponential / 2))
}

export interface ClaimedJob {
  id: string
  type: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
  orgId: string | null
}

/**
 * Atomically take up to `limit` due jobs.
 *
 * The update is conditional on status and lock token, so even if two workers
 * call this at the same instant exactly one claims each row. `updateMany`
 * returning count is what makes the claim safe — a plain `findMany` then
 * `update` would hand the same job to both workers.
 */
export async function claimJobs(limit = 5, lockToken: string): Promise<ClaimedJob[]> {
  return withRetry(async () => {
    const now = new Date()
    // Retry any RUNNING job whose worker died (lock older than 2 minutes).
    const stale = new Date(now.getTime() - 2 * 60_000)
    await prisma.job.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: stale } },
      data: { status: 'QUEUED', lockToken: null, lockedAt: null },
    })

    const candidates = await prisma.job.findMany({
      where: { status: 'QUEUED', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      take: limit,
      select: { id: true, type: true, payload: true, attempts: true, maxAttempts: true, orgId: true },
    })

    const claimed: ClaimedJob[] = []
    for (const candidate of candidates) {
      const result = await prisma.job.updateMany({
        where: { id: candidate.id, status: 'QUEUED' },
        data: {
          status: 'RUNNING',
          lockToken,
          lockedAt: new Date(),
          attempts: { increment: 1 },
        },
      })
      if (result.count === 1) {
        claimed.push({
          ...candidate,
          attempts: candidate.attempts + 1,
          payload: JSON.parse(candidate.payload || '{}') as Record<string, unknown>,
        })
      }
    }
    return claimed
  })
}

export async function completeJob(id: string, lockToken: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id, lockToken },
    data: { status: 'DONE', lockToken: null, lockedAt: null, lastError: null },
  })
}

export async function failJob(job: ClaimedJob, lockToken: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const exhausted = job.attempts >= job.maxAttempts
  await prisma.job.updateMany({
    where: { id: job.id, lockToken },
    data: exhausted
      ? { status: 'DEAD_LETTER', lockToken: null, lockedAt: null, lastError: message.slice(0, 1000) }
      : {
          status: 'QUEUED',
          lockToken: null,
          lockedAt: null,
          lastError: message.slice(0, 1000),
          runAt: new Date(Date.now() + backoffMs(job.attempts - 1)),
        },
  })
  if (exhausted) {
    console.error(`[job] dead-lettered ${job.type} (${job.id}): ${message}`)
  }
}

export async function queueDepth() {
  const rows = await prisma.job.groupBy({ by: ['status'], _count: { _all: true } })
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>
}
