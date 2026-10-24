/** Pure units: money, time and DST. No database involved. */
import { describe, expect, it } from 'vitest'
import { formatMoney, parseMoneyToMinor, percentage, minorUnitDigits } from '@/lib/money'
import {
  addLocalDays,
  dayBounds,
  isDstTransitionDate,
  localDateOf,
  localMinutesOf,
  weekdayOf,
  zonedInstant,
} from '@/lib/time'
import { resolveWindows } from '@/server/availability'
import { backoffMs } from '@/server/jobs'
import { evaluateCancellation } from '@/server/booking'

describe('money', () => {
  it('keeps amounts in integer minor units', () => {
    expect(parseMoneyToMinor('25.50')).toBe(2550)
    expect(parseMoneyToMinor('0.1')).toBe(10)
    expect(parseMoneyToMinor('0.2')).toBe(20)
    expect(parseMoneyToMinor(0.1) + parseMoneyToMinor(0.2)).toBe(30) // not 0.30000000000000004
    expect(parseMoneyToMinor('$1,299.99')).toBe(129999)
  })

  it('formats without float drift', () => {
    expect(formatMoney(2550)).toBe('$25.50')
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(100000, 'GBP')).toBe('£1,000.00')
  })

  it('knows which currencies have no minor unit', () => {
    expect(minorUnitDigits('JPY')).toBe(0)
    expect(parseMoneyToMinor('500', 'JPY')).toBe(500)
  })

  it('computes percentages without dividing by zero', () => {
    expect(percentage(1, 0)).toBe(0)
    expect(percentage(7, 9)).toBe(77.8)
  })
})

describe('time zones and DST', () => {
  it('converts a local wall clock to the right UTC instant', () => {
    // New York is UTC-4 in summer, UTC-5 in winter.
    expect(zonedInstant('2026-07-15', 600, 'America/New_York').toUTC().toISO()).toBe(
      '2026-07-15T14:00:00.000Z',
    )
    expect(zonedInstant('2026-01-15', 600, 'America/New_York').toUTC().toISO()).toBe(
      '2026-01-15T15:00:00.000Z',
    )
  })

  it('handles the spring-forward gap without inventing a time', () => {
    // 2026-03-08: 02:00 -> 03:00 in New York. 02:30 does not exist.
    const inGap = zonedInstant('2026-03-08', 150, 'America/New_York')
    expect(isDstTransitionDate('2026-03-08', 'America/New_York')).toBe(true)
    // Luxon resolves the nonexistent hour forward; our engine rejects it by
    // comparing the round-tripped wall clock.
    expect(inGap.hour * 60 + inGap.minute).not.toBe(150)
  })

  it('handles the fall-back overlap deterministically', () => {
    // 2026-11-01: 02:00 -> 01:00. 01:30 happens twice; we take the first.
    expect(isDstTransitionDate('2026-11-01', 'America/New_York')).toBe(true)
    const first = zonedInstant('2026-11-01', 90, 'America/New_York')
    expect(first.toUTC().toISO()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('round-trips local date and minutes', () => {
    const instant = zonedInstant('2026-05-04', 570, 'Europe/London').toUTC().toJSDate()
    expect(localDateOf(instant, 'Europe/London')).toBe('2026-05-04')
    expect(localMinutesOf(instant, 'Europe/London')).toBe(570)
    // Same instant, different zone, different wall clock: 09:30 BST is 08:30 UTC,
    // which is 13:30 in Karachi (UTC+5).
    expect(localMinutesOf(instant, 'Asia/Karachi')).toBe(810)
  })

  it('maps weekdays with Sunday as 0', () => {
    expect(weekdayOf('2026-10-25')).toBe(0) // Sunday
    expect(weekdayOf('2026-10-26')).toBe(1) // Monday
  })

  it('adds days across a month boundary and builds day bounds', () => {
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01')
    const { start, end } = dayBounds('2026-07-15', 'America/New_York')
    expect(end.getTime() - start.getTime()).toBe(24 * 3600_000)
  })
})

describe('working hour resolution', () => {
  const hours = [
    { weekday: 1, startMin: 540, endMin: 720 },
    { weekday: 1, startMin: 780, endMin: 1020 },
  ]

  it('returns both windows for a working day', () => {
    const { windows } = resolveWindows({ workingHours: hours, exceptions: [], weekday: 1 })
    expect(windows).toEqual([
      { startMin: 540, endMin: 720 },
      { startMin: 780, endMin: 1020 },
    ])
  })

  it('merges overlapping windows so a slot cannot be double counted', () => {
    // Extra hours 11:40–13:20 bridge the lunch gap (09:00–12:00, 13:00–17:00),
    // so the day collapses into one continuous window rather than three
    // overlapping ones that would each offer the same start times.
    const { windows } = resolveWindows({
      workingHours: hours,
      exceptions: [{ kind: 'EXTRA_HOURS', startMin: 700, endMin: 800 }],
      weekday: 1,
    })
    expect(windows).toEqual([{ startMin: 540, endMin: 1020 }])
  })

  it('blocks the whole day on leave', () => {
    const { windows, blocked } = resolveWindows({
      workingHours: hours,
      exceptions: [{ kind: 'LEAVE', startMin: null, endMin: null }],
      weekday: 1,
    })
    expect(blocked).toBe(true)
    expect(windows).toHaveLength(0)
  })
})

describe('retry backoff', () => {
  it('grows exponentially and stays under the cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = backoffMs(attempt, 1000, 60_000)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(60_000)
    }
    // First retry is in the hundreds of ms, later retries are measured in seconds.
    expect(backoffMs(0, 1000, 60_000)).toBeLessThan(1500)
    expect(backoffMs(5, 1000, 60_000)).toBeGreaterThan(8000)
  })
})

describe('cancellation policy', () => {
  it('is free outside the window and charges inside it', () => {
    const base = { now: new Date('2026-05-01T12:00:00Z'), windowHours: 24, amountPaidCents: 4000, priceCents: 12000 }
    const outside = evaluateCancellation({ ...base, startsAt: new Date('2026-05-03T12:00:00Z') })
    expect(outside.insideWindow).toBe(false)
    expect(outside.refundableCents).toBe(4000)

    const inside = evaluateCancellation({ ...base, startsAt: new Date('2026-05-02T00:00:00Z') })
    expect(inside.insideWindow).toBe(true)
    expect(inside.feeCents).toBe(4000)
  })

  it('never refunds more than was paid', () => {
    const policy = evaluateCancellation({
      startsAt: new Date('2026-05-03T12:00:00Z'),
      now: new Date('2026-05-01T12:00:00Z'),
      windowHours: 24,
      amountPaidCents: 20000, // more than the price, e.g. a double charge
      priceCents: 12000,
    })
    expect(policy.refundableCents + policy.feeCents).toBe(20000)
  })
})
