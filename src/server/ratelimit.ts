/**
 * In-process rate limiter.
 *
 * Adequate for a single self-hosted instance and for stopping the obvious
 * abuse cases on the public booking API (hold spam, credential stuffing).
 * Multi-instance deployments must swap the Map for Redis INCR/EXPIRE — the
 * call sites do not change, which is the point of keeping it behind a function.
 */
interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; remaining: number; retryAfter: number } {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, remaining: limit - 1, retryAfter: 0 }
  }
  existing.count++
  if (existing.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((existing.resetAt - now) / 1000) }
  }
  return { ok: true, remaining: limit - existing.count, retryAfter: 0 }
}

/** Client IP behind the preview proxy: prefer the forwarded chain. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'local'
}

/** Test helper — clears buckets between cases. */
export function resetRateLimits() {
  buckets.clear()
}

// Opportunistic cleanup so a long-running process does not leak memory.
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
}, 60_000).unref?.()
