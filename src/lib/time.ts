/**
 * Time handling.
 *
 * Rules this module enforces:
 *  1. Every instant that leaves this layer is a UTC `Date` / `DateTime`.
 *  2. Availability is computed by walking *local* wall-clock minutes, because
 *     "I work 09:00–17:00 on Tuesdays" is a local-clock statement. Naively
 *     adding 24h across a DST boundary shifts everyone's diary by an hour.
 *  3. When a local time does not exist (spring-forward gap) it is skipped, and
 *     when it exists twice (fall-back overlap) we take the first occurrence.
 */
import { DateTime, Interval } from 'luxon'

export const MINUTE_MS = 60_000

export function inZone(zone: string): DateTime {
  return DateTime.now().setZone(zone)
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid
}

/** "2026-03-08" + 570 minutes + "America/New_York" -> UTC instant */
export function zonedInstant(localDate: string, minutesFromMidnight: number, zone: string): DateTime {
  const day = DateTime.fromISO(localDate, { zone })
  if (!day.isValid) throw new Error(`Invalid local date ${localDate} for zone ${zone}`)
  const hour = Math.floor(minutesFromMidnight / 60)
  const minute = minutesFromMidnight % 60
  // Constructing via set() keeps the wall-clock intent; Luxon normalises gaps.
  return day.set({ hour, minute, second: 0, millisecond: 0 })
}

/** UTC instant -> "YYYY-MM-DD" in the given zone. */
type InstantLike = Date | DateTime | string

function toDateTime(instant: InstantLike): DateTime {
  if (typeof instant === 'string') {
    const parsed = DateTime.fromISO(instant, { zone: 'utc' })
    if (!parsed.isValid) throw new Error(`Invalid instant: ${instant}`)
    return parsed
  }
  return instant instanceof Date ? DateTime.fromJSDate(instant, { zone: 'utc' }) : instant
}

export function localDateOf(instant: InstantLike, zone: string): string {
  return toDateTime(instant).setZone(zone).toISODate()!
}

/** UTC instant -> minutes from local midnight in the given zone. */
export function localMinutesOf(instant: InstantLike, zone: string): number {
  const local = toDateTime(instant).setZone(zone)
  return local.hour * 60 + local.minute
}

export function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate, { zone: 'utc' }).weekday % 7 // Luxon: 1=Mon..7=Sun -> 0=Sun
}

export function addLocalDays(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: 'utc' }).plus({ days }).toISODate()!
}

export function localDateRange(startDate: string, endDateInclusive: string): string[] {
  const out: string[] = []
  let cursor = startDate
  let guard = 0
  while (cursor <= endDateInclusive && guard++ < 400) {
    out.push(cursor)
    cursor = addLocalDays(cursor, 1)
  }
  return out
}

/**
 * Real elapsed minutes between two local wall-clock times on one date.
 * On a spring-forward day 09:00–10:00 is only 60 real minutes but 01:30–03:30
 * is 60 real minutes even though the clock says 120 — this returns the truth.
 */
export function realDurationMinutes(start: DateTime, end: DateTime): number {
  return Math.round(end.diff(start, 'minutes').minutes)
}

/** Does this local date contain a DST transition in this zone? */
export function isDstTransitionDate(localDate: string, zone: string): boolean {
  const start = DateTime.fromISO(localDate, { zone }).startOf('day')
  return start.offset !== start.plus({ days: 1 }).startOf('day').offset
}

export function formatTime(instant: Date, zone: string, opts?: { seconds?: boolean }): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' })
    .setZone(zone)
    .toFormat(opts?.seconds ? 'HH:mm:ss' : 'HH:mm')
}

export function formatDateTime(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(zone).toFormat('LLL d, yyyy HH:mm')
}

export function prettyDate(localDate: string, zone?: string): string {
  return DateTime.fromISO(localDate, { zone: zone ?? 'utc' }).toFormat('ccc, LLL d')
}

export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

export function parseMinutesLabel(label: string): number {
  const [h, m] = label.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error(`Invalid time ${label}`)
  return h * 60 + m
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return Boolean(a.intersection(b))
}

/** Human label like "in 2h 15m" / "3 days ago" for operational UI. */
export function relativeLabel(target: Date, now = new Date()): string {
  const diffMin = Math.round((target.getTime() - now.getTime()) / MINUTE_MS)
  const abs = Math.abs(diffMin)
  const unit =
    abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`
  return diffMin >= 0 ? `in ${unit}` : `${unit} ago`
}

/** Start/end instants for a list of local dates in a zone. */
export function dayBounds(localDate: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(localDate, { zone }).startOf('day')
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() }
}

export { DateTime, Interval }
