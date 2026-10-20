// Exhaustive coverage of the flag decision. This is the pay-adjacent control
// on the trim floor, so every boundary is pinned: exactly-at-threshold must
// NOT flag, one hundredth of a gram over must.

import { describe, expect, it } from 'vitest'
import {
  computeVariance,
  evaluateVariance,
  DEFAULT_VARIANCE_PCT_THRESHOLD,
  DEFAULT_VARIANCE_FLOOR_G,
  type VarianceEvaluation,
  type VarianceInput,
  type VarianceInvalid,
} from './variance'

const T = { pctThreshold: 5, floorG: 25 }

function ok(input: VarianceInput, t = T): VarianceEvaluation {
  const r = evaluateVariance(input, t)
  if (!r.valid) throw new Error(`expected valid, got ${r.reason}`)
  return r
}
function bad(input: VarianceInput, t = T): VarianceInvalid {
  const r = evaluateVariance(input, t)
  if (r.valid) throw new Error('expected invalid')
  return r
}

describe('defaults', () => {
  it('start at 5% and 25 g', () => {
    expect(DEFAULT_VARIANCE_PCT_THRESHOLD).toBe(5)
    expect(DEFAULT_VARIANCE_FLOOR_G).toBe(25)
  })
})

describe('computeVariance: four-bucket arithmetic', () => {
  it('exact match is zero variance, direction none', () => {
    const r = computeVariance({ issuedG: 1000, flowerG: 800, trimG: 150, stemsG: 50 })
    expect(r).toMatchObject({ valid: true, varianceG: 0, variancePct: 0, direction: 'none' })
  })

  it('a complete return (remaining omitted) has processed = issued', () => {
    const r = computeVariance({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402 })
    expect(r).toMatchObject({ valid: true, remainingG: 0, processedG: 3821, returnedTotalG: 3402, varianceG: 419 })
  })

  it('remainingG: 0 is identical to omitting it', () => {
    const a = computeVariance({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402 })
    const b = computeVariance({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402, remainingG: 0 })
    expect(a).toEqual(b)
  })

  it('the plan example: 3821 issued, 3402 back is -/+ 11.0%', () => {
    const r = computeVariance({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402 })
    expect(r.valid && r.variancePct).toBe(10.966)
    expect(r.valid && r.direction).toBe('loss')
  })

  it('four buckets: remaining is subtracted from issued', () => {
    // 3000 issued, 2000 left on the hanger, 1000 processed: 600 + 300 + 90 back.
    const r = computeVariance({ issuedG: 3000, flowerG: 600, trimG: 300, stemsG: 90, remainingG: 2000 })
    expect(r).toMatchObject({ valid: true, processedG: 1000, returnedTotalG: 990, varianceG: 10, variancePct: 1 })
  })

  it('the denominator is processed_g, not issued_g', () => {
    // 300 g of work out of 3000 g issued, 100 g lost = 33.333% of the work.
    const r = computeVariance({ issuedG: 3000, flowerG: 150, trimG: 40, stemsG: 10, remainingG: 2700 })
    expect(r).toMatchObject({ valid: true, processedG: 300, varianceG: 100, variancePct: 33.333 })
  })

  it('negative variance (over-return) is a gain', () => {
    const r = computeVariance({ issuedG: 1000, flowerG: 900, trimG: 150, stemsG: 50 })
    expect(r).toMatchObject({ valid: true, varianceG: -100, variancePct: -10, direction: 'gain' })
  })

  it('rounds the percentage to 3 dp like the generated column', () => {
    const r = computeVariance({ issuedG: 3, flowerG: 1, trimG: 1, stemsG: 0 })
    expect(r.valid && r.variancePct).toBe(33.333)
    const g = computeVariance({ issuedG: 3, flowerG: 1, trimG: 1, stemsG: 2 })
    expect(g.valid && g.variancePct).toBe(-33.333)
  })

  it('has no float drift on awkward two-decimal sums', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in hundredths it is exact.
    const r = computeVariance({ issuedG: 0.6, flowerG: 0.1, trimG: 0.2, stemsG: 0.3 })
    expect(r).toMatchObject({ valid: true, varianceG: 0, variancePct: 0, direction: 'none' })
    const r2 = computeVariance({ issuedG: 1000.1, flowerG: 400.05, trimG: 300.02, stemsG: 300.03 })
    expect(r2).toMatchObject({ valid: true, varianceG: 0, returnedTotalG: 1000.1 })
  })

  it('all-zero returns lose everything: 100%', () => {
    const r = computeVariance({ issuedG: 3000, flowerG: 0, trimG: 0, stemsG: 0 })
    expect(r).toMatchObject({ valid: true, varianceG: 3000, variancePct: 100, direction: 'loss' })
  })
})

describe('evaluateVariance: guards', () => {
  it('zero issued is invalid, not NaN/Infinity', () => {
    expect(bad({ issuedG: 0, flowerG: 0, trimG: 0, stemsG: 0 }).reason).toBe('issued_not_positive')
  })
  it('negative issued is invalid', () => {
    expect(bad({ issuedG: -5, flowerG: 0, trimG: 0, stemsG: 0 }).reason).toBe('bad_weight')
  })
  it('remaining equal to issued leaves a zero denominator', () => {
    expect(bad({ issuedG: 1000, flowerG: 0, trimG: 0, stemsG: 0, remainingG: 1000 }).reason).toBe(
      'remaining_not_below_issued'
    )
  })
  it('remaining above issued leaves a negative denominator', () => {
    expect(bad({ issuedG: 1000, flowerG: 0, trimG: 0, stemsG: 0, remainingG: 1500 }).reason).toBe(
      'remaining_not_below_issued'
    )
  })
  it('remaining just under issued (0.01 g processed) is valid', () => {
    expect(ok({ issuedG: 1000, flowerG: 0, trimG: 0, stemsG: 0, remainingG: 999.99 }).processedG).toBe(0.01)
  })
  it.each([
    ['flower', { flowerG: -1 }],
    ['trim', { trimG: -0.01 }],
    ['stems', { stemsG: -1 }],
    ['remaining', { remainingG: -1 }],
    ['NaN flower', { flowerG: NaN }],
    ['Infinity stems', { stemsG: Infinity }],
  ])('rejects a bad %s weight', (_label, patch) => {
    const r = evaluateVariance({ issuedG: 1000, flowerG: 1, trimG: 1, stemsG: 1, ...patch }, T)
    expect(r.valid).toBe(false)
    expect(!r.valid && r.reason).toBe('bad_weight')
  })
  it('bucket weights of exactly 0 are valid (0 g of stems is normal)', () => {
    expect(ok({ issuedG: 1000, flowerG: 900, trimG: 100, stemsG: 0 }).status).toBe('ok')
  })
  it.each([
    [{ pctThreshold: -1, floorG: 25 }],
    [{ pctThreshold: 5, floorG: -1 }],
    [{ pctThreshold: NaN, floorG: 25 }],
    [{ pctThreshold: 5, floorG: Infinity }],
  ])('rejects bad thresholds %j', (t) => {
    const r = evaluateVariance({ issuedG: 1000, flowerG: 1, trimG: 1, stemsG: 1 }, t)
    expect(!r.valid && r.reason).toBe('bad_threshold')
  })
})

describe('evaluateVariance: the AND rule', () => {
  it('exact match is ok', () => {
    expect(ok({ issuedG: 1000, flowerG: 800, trimG: 150, stemsG: 50 }).status).toBe('ok')
  })

  it('within pct AND within floor: ok', () => {
    // 20 g of 1000 = 2%
    const r = ok({ issuedG: 1000, flowerG: 800, trimG: 130, stemsG: 50 })
    expect(r).toMatchObject({ status: 'ok', exceedsPct: false, exceedsFloor: false })
  })

  it('within pct but over the floor: ok (percent not exceeded)', () => {
    // 30 g of 3000 = 1% (> 25 g floor, < 5%)
    const r = ok({ issuedG: 3000, flowerG: 2000, trimG: 800, stemsG: 170 })
    expect(r).toMatchObject({ status: 'ok', exceedsPct: false, exceedsFloor: true })
  })

  it('over pct but under the floor: ok (small hanger, not flagged)', () => {
    // 10 g of 100 = 10% but only 10 g
    const r = ok({ issuedG: 100, flowerG: 60, trimG: 20, stemsG: 10 })
    expect(r).toMatchObject({ status: 'ok', exceedsPct: true, exceedsFloor: false })
  })

  it('both exceeded: flagged', () => {
    // 419 g of 3821 = ~11%
    const r = ok({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402 })
    expect(r).toMatchObject({ status: 'flagged', exceedsPct: true, exceedsFloor: true, direction: 'loss' })
  })

  it('negative variance (over-return) flags symmetrically', () => {
    const r = ok({ issuedG: 3000, flowerG: 2000, trimG: 1000, stemsG: 500 })
    expect(r).toMatchObject({ status: 'flagged', varianceG: -500, direction: 'gain' })
  })

  it('over-return under the floor does not flag', () => {
    const r = ok({ issuedG: 100, flowerG: 60, trimG: 30, stemsG: 20 })
    expect(r).toMatchObject({ status: 'ok', varianceG: -10, exceedsPct: true, exceedsFloor: false })
  })

  it('loss and gain of equal size give the same status', () => {
    const loss = ok({ issuedG: 1000, flowerG: 700, trimG: 150, stemsG: 100 })
    const gain = ok({ issuedG: 1000, flowerG: 800, trimG: 150, stemsG: 100 })
    expect(loss.variancePct).toBe(-gain.variancePct)
    expect(loss.status).toBe(gain.status)
  })

  it('all-zero returns on a normal hanger flag', () => {
    expect(ok({ issuedG: 3000, flowerG: 0, trimG: 0, stemsG: 0 }).status).toBe('flagged')
  })

  it('all-zero returns on a tiny hanger under the floor do not flag', () => {
    expect(ok({ issuedG: 20, flowerG: 0, trimG: 0, stemsG: 0 }).status).toBe('ok')
  })

  it('echoes the thresholds it judged under for the snapshot columns', () => {
    const r = ok({ issuedG: 1000, flowerG: 1, trimG: 1, stemsG: 1 }, { pctThreshold: 7.5, floorG: 12.5 })
    expect(r).toMatchObject({ pctThreshold: 7.5, floorG: 12.5 })
  })
})

describe('evaluateVariance: boundaries (exactly at threshold must NOT flag)', () => {
  it('exactly at the pct threshold, over the floor: ok', () => {
    // 5% of 2000 = 100 g (> 25 g floor)
    const r = ok({ issuedG: 2000, flowerG: 1500, trimG: 300, stemsG: 100 })
    expect(r).toMatchObject({ variancePct: 5, varianceG: 100, status: 'ok', exceedsPct: false, exceedsFloor: true })
  })

  it('a hair over the pct threshold (5.005%), over the floor: flagged', () => {
    // 5.005% of 2000 = 100.1 g
    const r = ok({ issuedG: 2000, flowerG: 1500, trimG: 299.9, stemsG: 100 })
    expect(r).toMatchObject({ variancePct: 5.005, status: 'flagged' })
  })

  it('exactly at the floor, over the pct: ok', () => {
    // 25 g of 200 = 12.5%
    const r = ok({ issuedG: 200, flowerG: 100, trimG: 50, stemsG: 25 })
    expect(r).toMatchObject({ varianceG: 25, variancePct: 12.5, status: 'ok', exceedsPct: true, exceedsFloor: false })
  })

  it('0.01 g over the floor, over the pct: flagged', () => {
    const r = ok({ issuedG: 200, flowerG: 100, trimG: 50, stemsG: 24.99 })
    expect(r).toMatchObject({ varianceG: 25.01, status: 'flagged' })
  })

  it('exactly at BOTH thresholds: ok', () => {
    // 25 g of 500 = 5%
    const r = ok({ issuedG: 500, flowerG: 400, trimG: 50, stemsG: 25 })
    expect(r).toMatchObject({ varianceG: 25, variancePct: 5, status: 'ok' })
  })

  it('just over both thresholds: flagged', () => {
    // 25.01 g of 500 = 5.002%
    const r = ok({ issuedG: 500, flowerG: 400, trimG: 50, stemsG: 24.99 })
    expect(r).toMatchObject({ varianceG: 25.01, variancePct: 5.002, status: 'flagged' })
  })

  it('negative side: exactly -5% / -25 g is ok, one hundredth beyond is flagged', () => {
    expect(ok({ issuedG: 500, flowerG: 400, trimG: 50, stemsG: 75 }).status).toBe('ok')
    expect(ok({ issuedG: 500, flowerG: 400, trimG: 50, stemsG: 75.01 }).status).toBe('flagged')
  })

  it('pct rounded to 3 dp is what is compared (matches the DB tripwire)', () => {
    // 5.0004% rounds to 5.000 -> not > 5 -> ok, exactly as the DB column would say.
    // issued 100000 g, variance 5000.4 g.
    const r = ok({ issuedG: 100000, flowerG: 94999.6, trimG: 0, stemsG: 0 })
    expect(r.variancePct).toBe(5)
    expect(r.status).toBe('ok')
  })

  it('zero thresholds flag any nonzero variance, never an exact match', () => {
    const z = { pctThreshold: 0, floorG: 0 }
    expect(ok({ issuedG: 1000, flowerG: 1000, trimG: 0, stemsG: 0 }, z).status).toBe('ok')
    expect(ok({ issuedG: 1000, flowerG: 999.99, trimG: 0, stemsG: 0 }, z).status).toBe('flagged')
  })
})

describe('evaluateVariance: tiny vs large hangers', () => {
  it('a 1 kg miss on a 100 kg load is 1%: ok even though it is far over the floor', () => {
    expect(ok({ issuedG: 100000, flowerG: 80000, trimG: 15000, stemsG: 4000 }).status).toBe('ok')
  })
  it('a 6 kg miss on a 100 kg load flags', () => {
    expect(ok({ issuedG: 100000, flowerG: 80000, trimG: 10000, stemsG: 4000 }).status).toBe('flagged')
  })
  it('a 30 g hanger that loses 25 g is 83% but exactly at the floor: ok; 25.01 g flags', () => {
    expect(ok({ issuedG: 30, flowerG: 3, trimG: 1, stemsG: 1 }).status).toBe('ok')
    expect(ok({ issuedG: 30, flowerG: 3, trimG: 1, stemsG: 0.99 }).status).toBe('flagged')
  })
})

describe('evaluateVariance: partial returns (R2.2)', () => {
  it('a clean partial return is ok', () => {
    const r = ok({ issuedG: 3000, flowerG: 600, trimG: 300, stemsG: 100, remainingG: 2000 })
    expect(r).toMatchObject({ status: 'ok', processedG: 1000, varianceG: 0 })
  })

  it('processed_g denominator flags what issued_g would hide', () => {
    // 100 g lost on 300 g of work: 33.3%. Against issued 3000 g it would be 3.3% and never flag.
    const r = ok({ issuedG: 3000, flowerG: 150, trimG: 40, stemsG: 10, remainingG: 2700 })
    expect(r.status).toBe('flagged')
    expect(r.variancePct).toBeGreaterThan(DEFAULT_VARIANCE_PCT_THRESHOLD)
  })

  it('a mis-weighed remainder shows up as variance', () => {
    // Remaining read 200 g too high: the work looks 200 g short.
    const r = ok({ issuedG: 3000, flowerG: 600, trimG: 300, stemsG: 100, remainingG: 2200 })
    expect(r).toMatchObject({ processedG: 800, varianceG: -200, status: 'flagged' })
  })

  it('a complete return equals the v1 (three-bucket) result', () => {
    const v1 = ok({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402 })
    const v2 = ok({ issuedG: 3821, flowerG: 2000, trimG: 1000, stemsG: 402, remainingG: 0 })
    expect(v2).toEqual(v1)
  })
})
