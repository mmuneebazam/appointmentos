/** Domain vocabularies. Kept as const unions so they survive the SQLite port. */

export const ROLES = ['OWNER', 'ADMIN', 'STAFF'] as const
export type Role = (typeof ROLES)[number]

export const APPOINTMENT_STATUS = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[number]

/** Statuses that physically occupy a staff member's time. */
export const OCCUPYING_STATUSES: AppointmentStatus[] = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED']

export const PAYMENT_STATUS = ['REQUIRES_PAYMENT', 'SUCCEEDED', 'FAILED', 'REFUNDED'] as const
export type PaymentStatus = (typeof PAYMENT_STATUS)[number]

export const NOTIFICATION_STATUS = ['QUEUED', 'SENT', 'FAILED', 'DEAD_LETTER'] as const
export type NotificationStatus = (typeof NOTIFICATION_STATUS)[number]

export const EXCEPTION_KINDS = ['LEAVE', 'HOLIDAY', 'EXTRA_HOURS'] as const
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function canManage(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}
