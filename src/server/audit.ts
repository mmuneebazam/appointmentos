/**
 * Append-only audit trail.
 *
 * Every state change that a customer or an accountant might later question gets
 * a row: who did it, to what, and with which before/after values. Rows are never
 * updated or deleted — corrections are new rows.
 */
import { prisma, type Tx } from '@/lib/db'

export interface AuditInput {
  orgId: string
  actorType: 'USER' | 'CUSTOMER' | 'SYSTEM' | 'WEBHOOK'
  actorId?: string | null
  action: string
  entityType: string
  entityId: string
  metadata?: Record<string, unknown>
  ip?: string | null
}

export async function recordAudit(input: AuditInput, db: Tx | typeof prisma = prisma) {
  return db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: JSON.stringify(input.metadata ?? {}),
      ip: input.ip ?? null,
    },
  })
}

/** Human-readable line for the dashboard activity feed. */
export function describeAudit(row: {
  action: string
  actorType: string
  metadata: string
}): string {
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(row.metadata) as Record<string, unknown>
  } catch {
    /* ignore malformed history rather than break the page */
  }
  const who =
    row.actorType === 'CUSTOMER'
      ? 'Customer'
      : row.actorType === 'SYSTEM'
        ? 'System'
        : row.actorType === 'WEBHOOK'
          ? 'Payment provider'
          : String(meta.actorName ?? 'Team member')
  const subject = String(meta.summary ?? row.action)
  return `${who} — ${subject}`
}
