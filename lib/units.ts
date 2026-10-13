// Shared weight-unit conversions.
//
// Grams are the stored unit everywhere (packages.current_weight, the vault
// transactions, and every trim_* weight column); pounds exist only at the input
// and display boundary and inside the trim pay formula.
//
// No imports, no I/O — safe to import from client components, 'use server'
// action files and tests alike.

/**
 * Exact definition of the avoirdupois pound in grams (international yard and
 * pound agreement, 1959). lib/trim/pay.ts and the SQL CHECK
 * `pay_amount_matches` on trim_pay_entries both hard-code this same constant —
 * change one and you must change all of them.
 */
export const GRAMS_PER_LB = 453.59237

/** Pounds -> grams, unrounded. Round at the boundary with roundGrams(). */
export function lbToGrams(lb: number): number {
  return lb * GRAMS_PER_LB
}

/** Grams -> pounds, unrounded. Round at the boundary with roundLb(). */
export function gramsToLb(grams: number): number {
  return grams / GRAMS_PER_LB
}

/**
 * Round half away from zero to `dp` decimal places, the same tie-break
 * Postgres uses for numeric round().
 *
 * Goes through the decimal string ("1.005e2" -> 100.5) rather than
 * multiplying by 10^dp, because 1.005 * 100 is 100.49999999999999 and would
 * round down to 1 instead of 1.01. Non-finite input is returned unchanged, as
 * is anything at or above 2^52 (already a whole number). Tiny numbers in
 * exponent notation (|n| < 1e-6) fall back to the multiply form, where the
 * trap above cannot arise at 2-3 dp.
 */
export function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 2 ** 52) return value
  const abs = Math.abs(value)
  const sign = value < 0 ? -1 : 1
  const text = String(abs)
  if (text.includes('e')) {
    const f = 10 ** dp
    return sign * (Math.round(abs * f) / f)
  }
  return sign * Number(`${Math.round(Number(`${text}e${dp}`))}e-${dp}`)
}

/** numeric(10,2) grams, the precision every weight column stores. */
export function roundGrams(grams: number): number {
  return roundTo(grams, 2)
}

/** Pounds at the 3 dp the lb input mode allows (0.001 lb = 0.45 g). */
export function roundLb(lb: number): number {
  return roundTo(lb, 3)
}

/** Money to whole cents. */
export function roundCents(dollars: number): number {
  return roundTo(dollars, 2)
}

/** Lb input -> stored grams: convert, then round to the 2 dp grams column. */
export function lbToStoredGrams(lb: number): number {
  return roundGrams(lbToGrams(lb))
}
