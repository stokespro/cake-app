import { describe, expect, it } from 'vitest'
import {
  KEYSTROKE_REGEX,
  MAX_WEIGHT_G,
  formatWeight,
  isKeystrokeAllowed,
  parseWeightInput,
  checkDryWetRatio,
  checkAgainstBatchAverage,
  checkFlowerAgainstIssued,
} from './weights'
import { GRAMS_PER_LB } from '@/lib/units'

describe('keystroke filter', () => {
  it.each([
    ['', true],
    ['.', true],
    ['5', true],
    ['5.', true],
    ['.5', true],
    ['123', true],
    ['123.4', true],
    ['123.45', true],
    ['123.456', false],
    ['-1', false],
    ['1e5', false],
    ['abc', false],
    ['1,5', false],
    ['1.2.3', false],
    [' 1', false],
  ])('grams: %j -> %s', (text, expected) => {
    expect(isKeystrokeAllowed(text, 'g')).toBe(expected)
  })

  it.each([
    ['2.4', true],
    ['2.41', true],
    ['2.413', true],
    ['2.4137', false],
    ['.001', true],
    ['abc', false],
  ])('pounds: %j -> %s', (text, expected) => {
    expect(isKeystrokeAllowed(text, 'lb')).toBe(expected)
  })

  it('exposes one regex per unit', () => {
    expect(KEYSTROKE_REGEX.g.source).toBe('^\\d*\\.?\\d{0,2}$')
    expect(KEYSTROKE_REGEX.lb.source).toBe('^\\d*\\.?\\d{0,3}$')
  })
})

describe('parseWeightInput: grams', () => {
  it('parses a plain value', () => {
    expect(parseWeightInput('3821', 'g')).toEqual({ ok: true, grams: 3821 })
  })
  it('keeps two decimals', () => {
    expect(parseWeightInput('1234.56', 'g')).toEqual({ ok: true, grams: 1234.56 })
  })
  it('accepts "5." and ".5"', () => {
    expect(parseWeightInput('5.', 'g')).toEqual({ ok: true, grams: 5 })
    expect(parseWeightInput('.5', 'g')).toEqual({ ok: true, grams: 0.5 })
  })
  it('trims whitespace', () => {
    expect(parseWeightInput('  42.5 ', 'g')).toEqual({ ok: true, grams: 42.5 })
  })
  it('rejects a third decimal instead of silently rounding', () => {
    expect(parseWeightInput('1.234', 'g')).toMatchObject({ ok: false, error: 'too_precise' })
  })
})

describe('parseWeightInput: pounds', () => {
  it('converts to 2 dp grams', () => {
    // 2.41 lb = 1093.1576 g
    expect(parseWeightInput('2.41', 'lb')).toEqual({ ok: true, grams: 1093.16 })
  })
  it('one pound is 453.59 g', () => {
    expect(parseWeightInput('1', 'lb')).toEqual({ ok: true, grams: 453.59 })
  })
  it('0.001 lb (the finest step) is 0.45 g', () => {
    expect(parseWeightInput('0.001', 'lb')).toEqual({ ok: true, grams: 0.45 })
  })
  it('accepts three decimals but not four', () => {
    expect(parseWeightInput('3.822', 'lb')).toMatchObject({ ok: true })
    expect(parseWeightInput('3.8221', 'lb')).toMatchObject({ ok: false, error: 'too_precise' })
  })
  it('lb -> g -> lb round trips at input precision', () => {
    for (const lb of ['0.001', '0.5', '2.413', '3.822', '10', '440.924']) {
      const r = parseWeightInput(lb, 'lb')
      expect(r.ok).toBe(true)
      if (r.ok) expect(Number(formatWeight(r.grams, 'lb'))).toBeCloseTo(Number(lb), 3)
    }
  })
})

describe('parseWeightInput: rejects', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'not_a_number'],
    ['.', 'not_a_number'],
    ['1,5', 'not_a_number'],
    ['1e3', 'not_a_number'],
    ['1.2.3', 'not_a_number'],
    ['NaN', 'not_a_number'],
    ['Infinity', 'not_a_number'],
    ['-5', 'negative'],
    ['-0.5', 'negative'],
    ['0', 'not_positive'],
    ['0.00', 'not_positive'],
    ['0.', 'not_positive'],
  ])('%j -> %s', (text, error) => {
    expect(parseWeightInput(text, 'g')).toMatchObject({ ok: false, error })
  })

  it('every failure carries a message', () => {
    const r = parseWeightInput('abc', 'g')
    expect(!r.ok && r.message.length).toBeGreaterThan(0)
  })

  it('null/undefined text is empty, not a crash', () => {
    expect(parseWeightInput(undefined as unknown as string, 'g')).toMatchObject({ ok: false, error: 'empty' })
    expect(parseWeightInput(null as unknown as string, 'g')).toMatchObject({ ok: false, error: 'empty' })
  })

  it('lb that rounds to 0 g is not positive', () => {
    // 0.000 lb
    expect(parseWeightInput('0.000', 'lb')).toMatchObject({ ok: false, error: 'not_positive' })
  })
})

describe('parseWeightInput: cap', () => {
  it('exactly the cap is accepted', () => {
    expect(parseWeightInput('200000', 'g')).toEqual({ ok: true, grams: MAX_WEIGHT_G })
  })
  it('one hundredth over is rejected', () => {
    expect(parseWeightInput('200000.01', 'g')).toMatchObject({ ok: false, error: 'over_cap' })
  })
  it('the cap applies after lb conversion', () => {
    // 440.925 lb = 200000.4 g > cap; 440.924 lb = 199999.9 g
    expect(parseWeightInput('440.924', 'lb')).toMatchObject({ ok: true })
    expect(parseWeightInput('440.925', 'lb')).toMatchObject({ ok: false, error: 'over_cap' })
    expect(parseWeightInput('500', 'lb')).toMatchObject({ ok: false, error: 'over_cap' })
  })
  it('honours a custom cap', () => {
    expect(parseWeightInput('1001', 'g', { maxG: 1000 })).toMatchObject({ ok: false, error: 'over_cap' })
    expect(parseWeightInput('1000', 'g', { maxG: 1000 })).toMatchObject({ ok: true })
  })
})

describe('parseWeightInput: allowZero (bucket weights)', () => {
  it('accepts 0 when allowed', () => {
    expect(parseWeightInput('0', 'g', { allowZero: true })).toEqual({ ok: true, grams: 0 })
    expect(parseWeightInput('0.00', 'lb', { allowZero: true })).toEqual({ ok: true, grams: 0 })
  })
  it('still rejects negatives, blanks and junk', () => {
    expect(parseWeightInput('-1', 'g', { allowZero: true })).toMatchObject({ ok: false, error: 'negative' })
    expect(parseWeightInput('', 'g', { allowZero: true })).toMatchObject({ ok: false, error: 'empty' })
    expect(parseWeightInput('x', 'g', { allowZero: true })).toMatchObject({ ok: false, error: 'not_a_number' })
  })
})

describe('formatWeight', () => {
  it('grams at 2 dp', () => {
    expect(formatWeight(3821, 'g')).toBe('3821.00')
  })
  it('pounds at 3 dp by default', () => {
    expect(formatWeight(GRAMS_PER_LB, 'lb')).toBe('1.000')
  })
  it('explicit dp', () => {
    expect(formatWeight(1734.3, 'lb', 2)).toBe('3.82')
  })
})

describe('checkDryWetRatio', () => {
  it('no warning inside 15-40%', () => {
    expect(checkDryWetRatio(250, 1000)).toBeNull()
  })
  it('exactly 15% and exactly 40% are fine', () => {
    expect(checkDryWetRatio(150, 1000)).toBeNull()
    expect(checkDryWetRatio(400, 1000)).toBeNull()
  })
  it('just under 15% warns low', () => {
    expect(checkDryWetRatio(149.99, 1000)).toMatchObject({ code: 'dry_wet_ratio_low' })
  })
  it('just over 40% warns high', () => {
    expect(checkDryWetRatio(400.01, 1000)).toMatchObject({ code: 'dry_wet_ratio_high' })
  })
  it('dry above wet (swapped fields) warns high', () => {
    expect(checkDryWetRatio(2000, 1000)).toMatchObject({ code: 'dry_wet_ratio_high' })
  })
  it('missing or non-positive wet gives no warning', () => {
    expect(checkDryWetRatio(250, null)).toBeNull()
    expect(checkDryWetRatio(null, 1000)).toBeNull()
    expect(checkDryWetRatio(250, 0)).toBeNull()
    expect(checkDryWetRatio(undefined, undefined)).toBeNull()
  })
  it('puts the ratio in the message', () => {
    expect(checkDryWetRatio(100, 1000)?.message).toContain('10.0%')
  })
  it('has no float false-positive at the boundary for awkward values', () => {
    // 0.15 * 3 = 0.45 and 1.2 / 3 = 0.4 are not exact in floats; integer hundredths are.
    expect(checkDryWetRatio(0.45, 3)).toBeNull() // exactly 15%
    expect(checkDryWetRatio(1.2, 3)).toBeNull() // exactly 40%
  })
})

describe('checkAgainstBatchAverage', () => {
  it('no warning at or under 3x', () => {
    expect(checkAgainstBatchAverage(3000, 1000)).toBeNull()
    expect(checkAgainstBatchAverage(1500, 1000)).toBeNull()
  })
  it('warns just over 3x', () => {
    expect(checkAgainstBatchAverage(3000.01, 1000)).toMatchObject({ code: 'over_batch_average' })
  })
  it('names the multiple', () => {
    expect(checkAgainstBatchAverage(5000, 1000)?.message).toContain('5.0x')
  })
  it('no average yet gives no warning', () => {
    expect(checkAgainstBatchAverage(9999, null)).toBeNull()
    expect(checkAgainstBatchAverage(9999, undefined)).toBeNull()
    expect(checkAgainstBatchAverage(9999, 0)).toBeNull()
  })
  it('a non-positive weight gives no warning', () => {
    expect(checkAgainstBatchAverage(0, 1000)).toBeNull()
    expect(checkAgainstBatchAverage(NaN, 1000)).toBeNull()
  })
})

describe('checkFlowerAgainstIssued', () => {
  it('flower under or equal to issued is fine', () => {
    expect(checkFlowerAgainstIssued(800, 1000)).toBeNull()
    expect(checkFlowerAgainstIssued(1000, 1000)).toBeNull()
  })
  it('flower over issued warns', () => {
    expect(checkFlowerAgainstIssued(1000.01, 1000)).toMatchObject({ code: 'flower_exceeds_issued' })
  })
  it('guards a bad issued weight', () => {
    expect(checkFlowerAgainstIssued(500, 0)).toBeNull()
    expect(checkFlowerAgainstIssued(NaN, 1000)).toBeNull()
  })
})
