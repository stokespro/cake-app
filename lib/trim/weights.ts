// Weight entry: keystroke filtering, parsing, unit conversion and the soft
// sanity warnings shown next to a weight field.
//
// Weights are plain NET values (the crew tares the empty hanger / bin before
// weighing — plan section 2.2), so there is no tare handling anywhere here.
//
// Precision: 2 dp in grams mode, 3 dp in pounds mode (0.001 lb = 0.45 g; 0.01 lb
// = 4.5 g would manufacture phantom variance on small returns). Everything is
// stored as numeric(10,2) grams, so a pounds entry is converted and rounded to
// 2 dp grams at the boundary, here.
//
// Hard rejects (parseWeightInput) stop bad data. Soft warnings (the check*
// functions) only ever annotate — they never block a save.
//
// Pure: no imports from actions/, no I/O, no DOM.

import { lbToStoredGrams, roundGrams, gramsToLb } from '@/lib/units'
import type { WeightUnit } from '@/types/harvest-trim'

/** Matches the CHECK on every weight column: > 0 and <= 200000 g. */
export const MAX_WEIGHT_G = 200000

/** Decimal places accepted per unit. */
export const WEIGHT_DECIMALS: Record<WeightUnit, number> = { g: 2, lb: 3 }

/**
 * Keystroke filter for a `type="text" inputMode="decimal"` field (the vault's
 * pattern): the next value of the field is only accepted if it matches. The
 * empty string and a lone "." pass so the user can clear and start typing.
 */
export const KEYSTROKE_REGEX: Record<WeightUnit, RegExp> = {
  g: /^\d*\.?\d{0,2}$/,
  lb: /^\d*\.?\d{0,3}$/,
}

export function isKeystrokeAllowed(next: string, unit: WeightUnit): boolean {
  return KEYSTROKE_REGEX[unit].test(next)
}

export type WeightParseError =
  | 'empty'
  | 'not_a_number'
  | 'negative'
  | 'too_precise'
  | 'not_positive'
  | 'over_cap'

export type WeightParseResult =
  | { ok: true; grams: number }
  | { ok: false; error: WeightParseError; message: string }

export interface ParseWeightOptions {
  /** Bucket weights (flower/trim/stems) may legitimately be 0. Default false. */
  allowZero?: boolean
  /** Override the cap in grams. Default MAX_WEIGHT_G. */
  maxG?: number
}

const MESSAGES: Record<WeightParseError, string> = {
  empty: 'Enter a weight.',
  not_a_number: 'Enter a number.',
  negative: 'Weight cannot be negative.',
  too_precise: 'Too many decimal places.',
  not_positive: 'Weight must be more than zero.',
  over_cap: 'That weight is too large.',
}

function fail(error: WeightParseError): WeightParseResult {
  return { ok: false, error, message: MESSAGES[error] }
}

/**
 * Parse what the user typed into stored grams (2 dp).
 *
 * Rejects empty, non-numeric, negative, over-precise (more decimals than the
 * unit allows — the keystroke filter should already prevent it, this is the
 * backstop for paste), zero (unless `allowZero`) and over-cap values. The cap
 * is checked after conversion, so 500 lb is over the cap even though "500" is
 * a small number.
 */
export function parseWeightInput(
  text: string,
  unit: WeightUnit,
  options: ParseWeightOptions = {}
): WeightParseResult {
  const t = String(text ?? '').trim()
  if (t === '') return fail('empty')
  if (/^-[\d.]+$/.test(t)) return fail('negative')
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return fail('not_a_number')

  const dot = t.indexOf('.')
  if (dot !== -1 && t.length - dot - 1 > WEIGHT_DECIMALS[unit]) return fail('too_precise')

  const value = Number(t)
  const grams = unit === 'g' ? roundGrams(value) : lbToStoredGrams(value)
  if (grams <= 0 && !(options.allowZero && grams === 0)) return fail('not_positive')
  if (grams > (options.maxG ?? MAX_WEIGHT_G)) return fail('over_cap')
  return { ok: true, grams }
}

/**
 * Stored grams -> the text for a weight field in `unit`. Grams show 2 dp;
 * pounds show 3 dp by default (the input precision) so a value round-trips
 * through parseWeightInput() unchanged.
 */
export function formatWeight(grams: number, unit: WeightUnit, dp = WEIGHT_DECIMALS[unit]): string {
  return (unit === 'g' ? grams : gramsToLb(grams)).toFixed(dp)
}

// ─── Soft warnings ───────────────────────────────────────────────────────────

export type WeightWarningCode =
  | 'dry_wet_ratio_low'
  | 'dry_wet_ratio_high'
  | 'over_batch_average'
  | 'flower_exceeds_issued'

export interface WeightWarning {
  code: WeightWarningCode
  message: string
}

/** Dry weight is normally 15-40% of wet; outside that is probably a typo or a swapped field. */
export const DRY_WET_MIN_PCT = 15
export const DRY_WET_MAX_PCT = 40

/** A single hanger over this multiple of the batch average so far is probably a typo. */
export const BATCH_AVERAGE_MULTIPLE = 3

function hundredths(g: number): number {
  return Math.round(g * 100)
}

/**
 * Warn when dry/wet falls outside 15-40%. Exactly 15% and exactly 40% are
 * fine. Compared in integer hundredths of a gram (dry*100 vs wet*pct) so a
 * boundary case can't be tipped by float division. Returns null when either
 * weight is missing or wet is not positive.
 */
export function checkDryWetRatio(
  dryG: number | null | undefined,
  wetG: number | null | undefined
): WeightWarning | null {
  if (dryG == null || wetG == null || !Number.isFinite(dryG) || !Number.isFinite(wetG)) return null
  const dry = hundredths(dryG)
  const wet = hundredths(wetG)
  if (wet <= 0 || dry < 0) return null
  const pct = ((dry / wet) * 100).toFixed(1)
  if (dry * 100 < wet * DRY_WET_MIN_PCT) {
    return {
      code: 'dry_wet_ratio_low',
      message: `Dry is only ${pct}% of wet (usually ${DRY_WET_MIN_PCT}-${DRY_WET_MAX_PCT}%). Check both weights.`,
    }
  }
  if (dry * 100 > wet * DRY_WET_MAX_PCT) {
    return {
      code: 'dry_wet_ratio_high',
      message: `Dry is ${pct}% of wet (usually ${DRY_WET_MIN_PCT}-${DRY_WET_MAX_PCT}%). Check both weights.`,
    }
  }
  return null
}

/**
 * Warn when one hanger weighs more than 3x the batch average so far (strictly
 * more: exactly 3x is fine). Null when there is no usable average yet.
 */
export function checkAgainstBatchAverage(
  weightG: number,
  batchAverageG: number | null | undefined
): WeightWarning | null {
  if (batchAverageG == null || !Number.isFinite(batchAverageG) || batchAverageG <= 0) return null
  if (!Number.isFinite(weightG) || weightG <= 0) return null
  if (hundredths(weightG) > BATCH_AVERAGE_MULTIPLE * hundredths(batchAverageG)) {
    const times = (weightG / batchAverageG).toFixed(1)
    return {
      code: 'over_batch_average',
      message: `${times}x the average hanger in this batch. Check the weight.`,
    }
  }
  return null
}

/**
 * Warn when flower alone is more than was issued — the signature of weighing
 * the bin gross instead of zeroing the scale with it empty. Strictly greater.
 */
export function checkFlowerAgainstIssued(
  flowerG: number,
  issuedG: number
): WeightWarning | null {
  if (!Number.isFinite(flowerG) || !Number.isFinite(issuedG) || issuedG <= 0) return null
  if (hundredths(flowerG) > hundredths(issuedG)) {
    return {
      code: 'flower_exceeds_issued',
      message: 'Flower is more than was issued. Zero the scale with the empty bin and enter net weight.',
    }
  }
  return null
}
