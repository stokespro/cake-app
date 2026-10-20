// Four-bucket variance and the flag decision for a trim check-in.
//
//   processed_g  = issued_g - remaining_g
//   variance_g   = issued_g - (flower_g + trim_g + stems_g + remaining_g)
//                = processed_g - (flower_g + trim_g + stems_g)
//   variance_pct = variance_g / processed_g * 100
//
// A complete return has remaining_g = 0, which makes processed_g = issued_g.
// The percentage denominator is processed_g, NOT issued_g: otherwise a
// 300 g episode out of a 3,000 g issue could lose 100 g (a third of the work
// done) and never flag under the AND rule.
//
// Flag rule: flagged only when BOTH |variance_pct| > pctThreshold AND
// |variance_g| > floorG (AND semantics — the floor suppresses scale noise on
// small hangers, the percent catches proportionally large misses). Symmetric:
// an over-return (negative variance) flags exactly like a loss. Exactly at
// either threshold is NOT a flag.
//
// Lockstep mirror of SQL: trim_checkouts.variance_g / variance_pct are
// generated columns and the co_ok_within_threshold CHECK refuses an 'ok' whose
// own snapshot is out of threshold:
//
//   abs(variance_g) <= flag_floor_g_applied OR abs(variance_pct) <= flag_pct_applied
//
// so this file compares against variance_pct ROUNDED TO 3 dp (the column's
// round(..., 3)) — that way TS says 'ok' exactly when the DB will accept 'ok'.
// All gram arithmetic is done in integer hundredths of a gram so 0.1 + 0.2
// style float drift can never move a boundary case.
//
// Pure: no imports from actions/, no I/O.

import { roundTo } from '@/lib/units'

/** Starting thresholds (plan Q8): flag at >5% AND >25 g. Tunable in trim_settings. */
export const DEFAULT_VARIANCE_PCT_THRESHOLD = 5
export const DEFAULT_VARIANCE_FLOOR_G = 25

export interface VarianceInput {
  /** Net grams handed to the trimmer for this episode. */
  issuedG: number
  flowerG: number
  trimG: number
  stemsG: number
  /** Net grams of plants still on the hanger (unfinished return). Omit or 0 for a complete return. */
  remainingG?: number
}

export interface VarianceThresholds {
  /** Percent, e.g. 5 for 5%. */
  pctThreshold: number
  /** Grams. */
  floorG: number
}

export type VarianceInvalidReason =
  | 'bad_weight'
  | 'issued_not_positive'
  | 'remaining_not_below_issued'
  | 'bad_threshold'

export interface VarianceInvalid {
  valid: false
  reason: VarianceInvalidReason
  message: string
}

/** loss = issued more than came back; gain = more came back than was issued. */
export type VarianceDirection = 'loss' | 'gain' | 'none'

export interface VarianceFigures {
  valid: true
  issuedG: number
  remainingG: number
  processedG: number
  returnedTotalG: number
  varianceG: number
  /** Signed, rounded to 3 dp like the generated column. */
  variancePct: number
  direction: VarianceDirection
}

export interface VarianceEvaluation extends VarianceFigures {
  status: 'ok' | 'flagged'
  exceedsPct: boolean
  exceedsFloor: boolean
  /** The thresholds this result was judged under, for the flag_*_applied snapshot. */
  pctThreshold: number
  floorG: number
}

/** Integer hundredths of a gram. Inputs are numeric(10,2) so this is exact. */
function hundredths(g: number): number {
  return Math.round(g * 100)
}

function isWeight(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * The four-bucket numbers, without any threshold. Safe to call on every
 * keystroke for the live banner. Returns `valid: false` (never throws, never
 * divides by zero) when the inputs can't form a meaningful percentage.
 */
export function computeVariance(input: VarianceInput): VarianceFigures | VarianceInvalid {
  const remainingG = input.remainingG ?? 0
  if (
    !isWeight(input.issuedG) ||
    !isWeight(input.flowerG) ||
    !isWeight(input.trimG) ||
    !isWeight(input.stemsG) ||
    !isWeight(remainingG)
  ) {
    return { valid: false, reason: 'bad_weight', message: 'Weights must be zero or more.' }
  }

  const issuedH = hundredths(input.issuedG)
  const remainingH = hundredths(remainingG)
  if (issuedH <= 0) {
    return { valid: false, reason: 'issued_not_positive', message: 'Issued weight must be more than zero.' }
  }
  const processedH = issuedH - remainingH
  if (processedH <= 0) {
    return {
      valid: false,
      reason: 'remaining_not_below_issued',
      message: 'Remaining weight must be less than the weight issued.',
    }
  }

  const returnedH = hundredths(input.flowerG) + hundredths(input.trimG) + hundredths(input.stemsG)
  const varianceH = processedH - returnedH
  return {
    valid: true,
    issuedG: issuedH / 100,
    remainingG: remainingH / 100,
    processedG: processedH / 100,
    returnedTotalG: returnedH / 100,
    varianceG: varianceH / 100,
    // (varianceH * 100) / processedH is a single correctly-rounded division.
    variancePct: roundTo((varianceH * 100) / processedH, 3),
    direction: varianceH > 0 ? 'loss' : varianceH < 0 ? 'gain' : 'none',
  }
}

/**
 * Four-bucket variance plus the flag decision.
 *
 * Flagged iff |variancePct| > pctThreshold AND |varianceG| > floorG, both
 * strict. Thresholds that are negative or non-finite are `bad_threshold`
 * rather than silently flagging everything.
 */
export function evaluateVariance(
  input: VarianceInput,
  thresholds: VarianceThresholds
): VarianceEvaluation | VarianceInvalid {
  const { pctThreshold, floorG } = thresholds
  if (!isWeight(pctThreshold) || !isWeight(floorG)) {
    return { valid: false, reason: 'bad_threshold', message: 'Variance thresholds must be zero or more.' }
  }

  const figures = computeVariance(input)
  if (!figures.valid) return figures

  const exceedsPct = Math.abs(figures.variancePct) > pctThreshold
  const exceedsFloor = hundredths(Math.abs(figures.varianceG)) > hundredths(floorG)
  return {
    ...figures,
    exceedsPct,
    exceedsFloor,
    status: exceedsPct && exceedsFloor ? 'flagged' : 'ok',
    pctThreshold,
    floorG,
  }
}
