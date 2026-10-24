import { PrismaClient } from '@prisma/client'

/**
 * One client per process. Next.js dev recompiles modules on every request, so
 * without the global cache we would leak connection pools until SQLite refuses
 * to open another handle.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

const BUSY_RETRIES = 6

/**
 * SQLite serialises writers and surfaces contention as a busy error rather than
 * waiting forever. Retrying with jitter turns that into a transparent delay for
 * the caller — the same discipline we rely on for Postgres serialization
 * failures in production.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = BUSY_RETRIES): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const retryable =
        /SQLITE_BUSY|database is locked|write conflict|could not serialize|deadlock/i.test(message)
      if (!retryable || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 12 * 2 ** i + Math.random() * 15))
    }
  }
  throw lastError
}

/** True when a unique-constraint violation came from the slot guard. */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  const message = err instanceof Error ? err.message : String(err)
  if (!/P2002|unique constraint/i.test(message)) return false
  return field ? message.includes(field) : true
}
