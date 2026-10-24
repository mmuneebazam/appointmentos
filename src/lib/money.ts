/**
 * Money is always an integer count of minor units (cents/pence/yen).
 * Floating point never touches a stored amount — 0.1 + 0.2 != 0.3 and invoices
 * have to reconcile to the cent.
 */

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', PKR: '₨', INR: '₹', CAD: 'C$', AUD: 'A$', AED: 'د.إ',
}

/** Currencies with no minor unit. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP'])

export function minorUnitDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2
}

export function formatMoney(cents: number, currency = 'USD'): string {
  const digits = minorUnitDigits(currency)
  const value = cents / 10 ** digits
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    return `${SYMBOLS[currency] ?? ''}${value.toFixed(digits)}`
  }
}

/** "$25.50" | "25.5" | 2550 -> 2550 (minor units) */
export function parseMoneyToMinor(input: string | number, currency = 'USD'): number {
  const digits = minorUnitDigits(currency)
  const raw = typeof input === 'number' ? input.toString() : input.trim().replace(/[^0-9.\-]/g, '')
  if (raw === '' || Number.isNaN(Number(raw))) throw new Error(`Invalid amount: ${input}`)
  // Round half-away-from-zero explicitly; toFixed would introduce float drift.
  const factor = 10 ** digits
  const scaled = Number(raw) * factor
  return Math.round(scaled + Math.sign(scaled) * 1e-9)
}

export function percentage(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 1000) / 10
}
