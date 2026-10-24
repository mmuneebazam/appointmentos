/**
 * Background worker.
 *
 * Runs as a separate process (`npm run worker`) exactly as it would in
 * production behind a supervisor. Crash-safety comes from the queue: a job
 * claimed but never completed has its lock expire and is re-claimed, and every
 * handler is written to be safe to run twice.
 */
import { randomUUID } from 'node:crypto'
import { claimJobs, completeJob, failJob, queueDepth, type ClaimedJob } from '../server/jobs'
import { deliverNotification } from '../server/notifications'
import { expireHold, processRefundJob } from '../server/booking'
import { syncAppointment } from '../server/integrations/calendar'
import { reprocessWebhookEvent } from '../server/webhooks'
import { prisma } from '../lib/db'

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`

async function runJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload as Record<string, string>
  switch (job.type) {
    case 'notification.send':
      await deliverNotification(payload.notificationId)
      break
    case 'hold.expire':
      await expireHold(payload.holdId)
      break
    case 'calendar.sync':
      await syncAppointment(payload.appointmentId, (payload.action as 'upsert' | 'delete') ?? 'upsert')
      break
    case 'webhook.process':
      await reprocessWebhookEvent(payload.eventRowId)
      break
    case 'payment.refund':
      await processRefundJob(payload.refundId)
      break
    default:
      // Unknown type must not wedge the queue — dead-letter it for a human.
      throw new Error(`Unsupported job type: ${job.type}`)
  }
}

export async function drainOnce(limit = 10): Promise<number> {
  const jobs = await claimJobs(limit, WORKER_ID)
  for (const job of jobs) {
    try {
      await runJob(job)
      await completeJob(job.id, WORKER_ID)
    } catch (err) {
      await failJob(job, WORKER_ID, err)
      console.error(`[${WORKER_ID}] job ${job.type} failed`, err instanceof Error ? err.message : err)
    }
  }
  return jobs.length
}

async function main() {
  const once = process.argv.includes('--once')
  console.log(`[${WORKER_ID}] started${once ? ' (single pass)' : ''}`)

  if (once) {
    let processed = 0
    // Keep going until the queue stops producing work we can finish now.
    for (let i = 0; i < 50; i++) {
      const count = await drainOnce(10)
      processed += count
      if (count === 0) break
    }
    console.log(`[${WORKER_ID}] drained ${processed} job(s)`, await queueDepth())
    await prisma.$disconnect()
    return
  }

  let running = true
  const shutdown = async (signal: string) => {
    console.log(`[${WORKER_ID}] ${signal} received — finishing current job`)
    running = false
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  while (running) {
    try {
      const count = await drainOnce(5)
      if (count === 0) await new Promise((r) => setTimeout(r, 1000))
    } catch (err) {
      // The loop must survive a database hiccup; log and keep polling.
      console.error(`[${WORKER_ID}] poll error`, err)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  await prisma.$disconnect()
  console.log(`[${WORKER_ID}] stopped`)
}

if (require.main === module) {
  void main()
}
