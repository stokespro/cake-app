// computePayAmount() is checked against the SQL CHECK pay_amount_matches on
// trim_pay_entries: abs(amount - flower/453.59237*rate) <= 0.0051 must hold
// for every input, or a check-in RPC would be rejected at the database.

import { describe, expect, it } from 'vitest'
import {
  computePayAmount,
  payTripwireHolds,
  sumMoney,
  isValidRate,
  PAY_TRIPWIRE_TOLERANCE,
  MAX_RATE_PER_LB,
} from './pay'
import { GRAMS_PER_LB } from '@/lib/units'

describe('constants', () => {
  it('tolerance and rate cap match the SQL', () => {
    expect(PAY_TRIPWIRE_TOLERANCE).toBe(0.0051)
    expect(MAX_RATE_PER_LB).toBe(1000)
  })
})

describe('computePayAmount: known fixtures', () => {
  it('exactly one pound pays exactly the rate', () => {
    expect(computePayAmount(GRAMS_PER_LB, 225)).toBe(225)
  })
  it('two pounds at $250', () => {
    expect(computePayAmount(GRAMS_PER_LB * 2, 250)).toBe(500)
  })
  it('half a pound at $225 is $112.50', () => {
    expect(computePayAmount(GRAMS_PER_LB / 2, 225)).toBe(112.5)
  })
  it('1000 g at $225/lb', () => {
    // 1000 / 453.59237 * 225 = 496.0… -> 496.04
    expect(computePayAmount(1000, 225)).toBe(496.04)
  })
  it('3820.55 g at $200/lb', () => {
    // 3820.55 / 453.59237 * 200 = 1684.574…
    expect(computePayAmount(3820.55, 200)).toBe(1684.57)
  })
  it('one gram at $225/lb is about 50 cents', () => {
    expect(computePayAmount(1, 225)).toBe(0.5)
  })
  it('a fractional rate', () => {
    expect(computePayAmount(GRAMS_PER_LB, 212.5)).toBe(212.5)
  })
})

describe('computePayAmount: edges', () => {
  it('zero flower pays zero', () => {
    expect(computePayAmount(0, 225)).toBe(0)
  })
  it('zero rate pays zero', () => {
    expect(computePayAmount(5000, 0)).toBe(0)
  })
  it('both zero pays zero', () => {
    expect(computePayAmount(0, 0)).toBe(0)
  })
  it('rounds half a cent up (exact half: 0.01 lb-equivalent)', () => {
    // Exactly one pound, so the amount equals the rate: a rate of x.xx5 is a half-cent tie.
    expect(computePayAmount(GRAMS_PER_LB, 0.005)).toBe(0.01)
    expect(computePayAmount(GRAMS_PER_LB, 1.005)).toBe(1.01)
    expect(computePayAmount(GRAMS_PER_LB, 2.675)).toBe(2.68)
  })
  it('rounds just under half a cent down', () => {
    expect(computePayAmount(GRAMS_PER_LB, 0.0049)).toBe(0)
    expect(computePayAmount(GRAMS_PER_LB, 1.0049)).toBe(1)
  })
  it('large weights: 200,000 g (the cap) at $1000/lb', () => {
    const amt = computePayAmount(200000, 1000)
    expect(amt).toBe(440924.52)
    expect(payTripwireHolds(amt, 200000, 1000)).toBe(true)
  })
  it('returns at most two decimal places', () => {
    for (const [g, r] of [[1234.56, 217.35], [999.99, 199.99], [7.77, 333.33]]) {
      const amt = computePayAmount(g, r)
      expect(Math.round(amt * 100) / 100).toBe(amt)
    }
  })
  it.each([
    [-1, 225],
    [NaN, 225],
    [Infinity, 225],
    [100, -1],
    [100, NaN],
    [100, Infinity],
  ])('throws RangeError on (%s g, $%s/lb)', (g, r) => {
    expect(() => computePayAmount(g, r)).toThrow(RangeError)
  })
})

describe('the SQL tripwire: abs(amount - flower/453.59237*rate) <= 0.0051', () => {
  it('holds on a dense grid of flower x rate', () => {
    let checked = 0
    for (let g = 0; g <= 200000; g += 773.37) {
      for (const rate of [0, 0.01, 1, 50, 100, 199.99, 225, 250, 333.33, 500, 999.99, 1000]) {
        const flower = Math.round(g * 100) / 100
        const amt = computePayAmount(flower, rate)
        expect(payTripwireHolds(amt, flower, rate)).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(3000)
  })

  it('holds on 50,000 pseudo-random 2dp weights and 2dp rates', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20261012
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let i = 0; i < 50000; i++) {
      const flower = Math.round(rnd() * 200000 * 100) / 100
      const rate = Math.round(rnd() * 1000 * 100) / 100
      const amt = computePayAmount(flower, rate)
      if (!payTripwireHolds(amt, flower, rate)) {
        throw new Error(`tripwire broke at flower=${flower} rate=${rate} amount=${amt}`)
      }
    }
  })

  it('holds at engineered half-cent ties', () => {
    for (const rate of [0.005, 0.015, 1.005, 2.675, 10.125, 100.005]) {
      const amt = computePayAmount(GRAMS_PER_LB, rate)
      expect(payTripwireHolds(amt, GRAMS_PER_LB, rate)).toBe(true)
    }
  })

  it('refuses an amount that is a cent off', () => {
    const amt = computePayAmount(1000, 225)
    expect(payTripwireHolds(amt + 0.01, 1000, 225)).toBe(false)
    expect(payTripwireHolds(amt - 0.01, 1000, 225)).toBe(false)
  })

  it('accepts an amount up to the half cent and refuses just past the tolerance', () => {
    const exact = (1000 / GRAMS_PER_LB) * 225
    expect(payTripwireHolds(exact + 0.005, 1000, 225)).toBe(true)
    expect(payTripwireHolds(exact + 0.0052, 1000, 225)).toBe(false)
  })
})

describe('sumMoney', () => {
  it('sums without float drift', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3)
    expect(sumMoney([10.1, 20.2, 30.3])).toBe(60.6)
  })
  it('empty sums to zero', () => {
    expect(sumMoney([])).toBe(0)
  })
  it('a payout is the sum of rounded entries, not a rounding of the whole', () => {
    // Three hangers whose per-entry cents round up; the total of totals would differ.
    const flowers = [GRAMS_PER_LB * 0.00001 * 100, GRAMS_PER_LB * 0.00001 * 100, GRAMS_PER_LB * 0.00001 * 100]
    const entries = flowers.map((g) => computePayAmount(g, 5))
    const sum = sumMoney(entries)
    expect(sum).toBe(Math.round(entries.reduce((a, b) => a + b * 100, 0)) / 100)
  })
  it('sum of many per-entry amounts stays within 0.005 x n of the unrounded total', () => {
    const flowers = Array.from({ length: 300 }, (_, i) => 1500 + i * 3.37)
    const entries = flowers.map((g) => computePayAmount(Math.round(g * 100) / 100, 225))
    const unrounded = flowers.reduce((a, g) => a + (Math.round(g * 100) / 100 / GRAMS_PER_LB) * 225, 0)
    expect(Math.abs(sumMoney(entries) - unrounded)).toBeLessThanOrEqual(0.005 * flowers.length)
  })
})

describe('isValidRate', () => {
  it.each([[0, true], [225, true], [1000, true], [1000.01, false], [-0.01, false], [NaN, false], [Infinity, false]])(
    '%s -> %s',
    (r, expected) => {
      expect(isValidRate(r)).toBe(expected)
    }
  )
})
