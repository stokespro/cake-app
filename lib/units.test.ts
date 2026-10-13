import { describe, expect, it } from 'vitest'
import {
  GRAMS_PER_LB,
  gramsToLb,
  lbToGrams,
  lbToStoredGrams,
  roundCents,
  roundGrams,
  roundLb,
  roundTo,
} from './units'

describe('GRAMS_PER_LB', () => {
  it('is the exact international pound', () => {
    expect(GRAMS_PER_LB).toBe(453.59237)
  })
})

describe('lbToGrams / gramsToLb', () => {
  it('one pound', () => {
    expect(lbToGrams(1)).toBe(453.59237)
    expect(gramsToLb(453.59237)).toBe(1)
  })
  it('zero', () => {
    expect(lbToGrams(0)).toBe(0)
    expect(gramsToLb(0)).toBe(0)
  })
  it('round trips', () => {
    for (const lb of [0.001, 0.5, 2.41, 3.822, 10, 440.924]) {
      expect(gramsToLb(lbToGrams(lb))).toBeCloseTo(lb, 10)
    }
    for (const g of [0.01, 1, 453.59, 3821, 199999.99]) {
      expect(lbToGrams(gramsToLb(g))).toBeCloseTo(g, 8)
    }
  })
  it('does not round (unrounded in, unrounded out)', () => {
    expect(lbToGrams(2.41)).toBeCloseTo(1093.1576117, 6)
  })
})

describe('roundTo and friends', () => {
  it('rounds half away from zero, avoiding the 1.005 float trap', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(2.675, 2)).toBe(2.68)
    expect(roundTo(0.005, 2)).toBe(0.01)
    expect(roundTo(1.0049, 2)).toBe(1)
  })
  it('is symmetric for negatives', () => {
    expect(roundTo(-1.005, 2)).toBe(-1.01)
    expect(roundTo(-0.004, 2)).toBe(-0)
    expect(roundTo(-2.5, 0)).toBe(-3)
  })
  it('passes non-finite values through', () => {
    expect(roundTo(NaN, 2)).toBeNaN()
    expect(roundTo(Infinity, 2)).toBe(Infinity)
  })
  it('handles values in exponent notation', () => {
    expect(roundTo(1e-9, 2)).toBe(0)
    expect(roundTo(1e21, 2)).toBe(1e21)
  })
  it('leaves already-rounded values alone', () => {
    expect(roundTo(12.34, 2)).toBe(12.34)
    expect(roundTo(0, 2)).toBe(0)
  })
  it('roundGrams = 2 dp, roundLb = 3 dp, roundCents = 2 dp', () => {
    expect(roundGrams(1093.1572)).toBe(1093.16)
    expect(roundLb(2.41337)).toBe(2.413)
    expect(roundCents(496.0449)).toBe(496.04)
  })
})

describe('lbToStoredGrams: 3-dp lb to 2-dp grams', () => {
  it.each([
    [1, 453.59],
    [0.001, 0.45],
    [0.002, 0.91],
    [2.413, 1094.52],
    [3.822, 1733.63],
    [10, 4535.92],
  ])('%s lb -> %s g', (lb, g) => {
    expect(lbToStoredGrams(lb)).toBe(g)
  })

  it('every 3-dp lb value up to 5 lb lands within 0.005 g of the exact conversion', () => {
    for (let k = 0; k <= 5000; k++) {
      const lb = k / 1000
      expect(Math.abs(lbToStoredGrams(lb) - lbToGrams(lb))).toBeLessThanOrEqual(0.005 + 1e-9)
    }
  })
})
