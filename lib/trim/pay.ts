// Trim pay: flower grams x snapshotted $/lb -> dollars.
//
//   amount = round_half_away_from_zero( (flowerG / 453.59237) * ratePerLb , 2 dp )
//
// Lockstep mirror of SQL: trim_pay_entries.pay_amount_matches is
//
//   abs(amount - (flower_g / 453.59237) * rate_per_lb_applied) <= 0.0051
//
// Rounding to cents moves the value by at most 0.005, so the 0.0051 tolerance
// is the half-cent plus a hair of float/numeric slack, and every result of
// computePayAmount() satisfies the CHECK. payTripwireHolds() is that CHECK in
// TS so tests (and the check-in action, before the RPC) can assert it.
// 453.59237 is lib/units.ts GRAMS_PER_LB; the SQL hard-codes the same literal.
//
// `flowerG` must be the value that will be STORED (numeric(10,2) — lib/trim/
// weights.ts parseWeightInput() already rounds to 2 dp). This function does not
// round it: rounding here would make the tripwire compare against a different
// flower figure than the caller passed in.
//
// Pure: no imports from actions/, no I/O.

import { GRAMS_PER_LB, roundCents } from '@/lib/units'

/** Same 0.0051 as the SQL CHECK. */
export const PAY_TRIPWIRE_TOLERANCE = 0.0051

/** Same bound as trim_staff.pay_per_lb CHECK (0..1000). */
export const MAX_RATE_PER_LB = 1000

/** True when `rate` is a usable $/lb: finite, 0..MAX_RATE_PER_LB. */
export function isValidRate(rate: number): boolean {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= MAX_RATE_PER_LB
}

/**
 * Dollars owed for `flowerG` grams of flower at `ratePerLb`, rounded to cents.
 * Zero flower or a zero rate pays 0. Throws RangeError on a negative or
 * non-finite weight or rate — callers validate first, and paying NaN is worse
 * than failing loudly.
 */
export function computePayAmount(flowerG: number, ratePerLb: number): number {
  if (typeof flowerG !== 'number' || !Number.isFinite(flowerG) || flowerG < 0) {
    throw new RangeError(`flowerG must be a finite number >= 0, got ${flowerG}`)
  }
  if (typeof ratePerLb !== 'number' || !Number.isFinite(ratePerLb) || ratePerLb < 0) {
    throw new RangeError(`ratePerLb must be a finite number >= 0, got ${ratePerLb}`)
  }
  return roundCents((flowerG / GRAMS_PER_LB) * ratePerLb)
}

/** The pay_amount_matches CHECK, in TS. */
export function payTripwireHolds(amount: number, flowerG: number, ratePerLb: number): boolean {
  return Math.abs(amount - (flowerG / GRAMS_PER_LB) * ratePerLb) <= PAY_TRIPWIRE_TOLERANCE
}

/**
 * Sum of dollar amounts without float drift (adds integer cents). Used for a
 * trimmer's batch total: a payout is the sum of its entries' already-rounded
 * amounts, NOT a re-rounding of total flower x rate, so the bill matches the
 * sum of the lines finance sees.
 */
export function sumMoney(amounts: readonly number[]): number {
  let cents = 0
  for (const a of amounts) cents += Math.round(a * 100)
  return cents / 100
}
