import { describe, expect, it } from 'vitest'
import {
  HANGER_PREFIXES,
  HANGER_DIGITS,
  MAX_HANGER_SEQ,
  HANGER_CODE_PATTERN,
  formatHangerCode,
  isHangerCode,
  parseHangerCodeLenient,
  parseHangerCodeStrict,
} from './hanger-code'

const METRC = '1A4FF0100000022000001234'

describe('constants', () => {
  it('is the H1B- fleet, 3 digits', () => {
    expect([...HANGER_PREFIXES]).toEqual(['H1B-'])
    expect(HANGER_DIGITS).toBe(3)
    expect(MAX_HANGER_SEQ).toBe(999)
  })
})

describe('formatHangerCode: canonical form', () => {
  it.each([
    [1, 'H1B-001'],
    [42, 'H1B-042'],
    [300, 'H1B-300'],
    [999, 'H1B-999'],
  ])('%i -> %s', (n, code) => {
    expect(formatHangerCode(n)).toBe(code)
  })

  it.each([0, -1, 1000, 1.5, NaN])('throws on %s', (n) => {
    expect(() => formatHangerCode(n)).toThrow(RangeError)
  })

  it('canonical output always matches the strict pattern', () => {
    for (let n = 1; n <= 999; n++) expect(HANGER_CODE_PATTERN.test(formatHangerCode(n))).toBe(true)
  })
})

describe('parseHangerCodeLenient: typed input', () => {
  it.each([
    ['42', 'H1B-042'],
    ['7', 'H1B-007'],
    ['007', 'H1B-007'],
    ['042', 'H1B-042'],
    ['999', 'H1B-999'],
    ['h1b42', 'H1B-042'],
    ['H1B42', 'H1B-042'],
    ['H1B-42', 'H1B-042'],
    ['h1b-042', 'H1B-042'],
    ['H1B-042', 'H1B-042'],
    ['  h1b-42  ', 'H1B-042'],
    ['H1B-1', 'H1B-001'],
    ['H1B300', 'H1B-300'],
  ])('%j -> %s', (typed, code) => {
    const r = parseHangerCodeLenient(typed)
    expect(r).toMatchObject({ ok: true, code })
  })

  it('returns the numeric sequence and prefix', () => {
    expect(parseHangerCodeLenient('h1b42')).toEqual({ ok: true, code: 'H1B-042', prefix: 'H1B-', seq: 42 })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['0', 'out_of_range'],
    ['000', 'out_of_range'],
    ['H1B-000', 'out_of_range'],
    ['1000', 'invalid_format'],
    ['H1B-1000', 'invalid_format'],
    ['H1C-042', 'invalid_format'],
    ['42-H1B', 'invalid_format'],
    ['H1B-', 'invalid_format'],
    ['H1B-4a', 'invalid_format'],
    ['-42', 'invalid_format'],
    ['4.2', 'invalid_format'],
    ['H1B 042', 'invalid_format'],
    ['hello', 'invalid_format'],
  ])('rejects %j (%s)', (typed, error) => {
    expect(parseHangerCodeLenient(typed)).toMatchObject({ ok: false, error })
  })

  it('rejects a 24-char Metrc tag, even all-digit ones', () => {
    expect(parseHangerCodeLenient(METRC)).toMatchObject({ ok: false, error: 'looks_like_metrc_tag' })
    expect(parseHangerCodeLenient(METRC.toLowerCase())).toMatchObject({ ok: false, error: 'looks_like_metrc_tag' })
    expect(parseHangerCodeLenient('1'.repeat(24))).toMatchObject({ ok: false, error: 'looks_like_metrc_tag' })
  })

  it('null/undefined are empty, not a crash', () => {
    expect(parseHangerCodeLenient(undefined as unknown as string)).toMatchObject({ ok: false, error: 'empty' })
  })
})

describe('parseHangerCodeStrict: wedge and camera input', () => {
  it('accepts exactly the canonical form', () => {
    expect(parseHangerCodeStrict('H1B-042')).toEqual({ ok: true, code: 'H1B-042', prefix: 'H1B-', seq: 42 })
    expect(parseHangerCodeStrict('H1B-001')).toMatchObject({ ok: true, seq: 1 })
    expect(parseHangerCodeStrict('H1B-999')).toMatchObject({ ok: true, seq: 999 })
  })

  it.each([
    ['42'],
    ['H1B-42'],
    ['H1B42'],
    ['h1b-042'],
    [' H1B-042'],
    ['H1B-042 '],
    ['H1B-042\n'],
    ['~H1B-042'],
    ['H1B-0042'],
    ['H1B-1000'],
    ['H1C-042'],
  ])('rejects the non-canonical %j', (raw) => {
    expect(parseHangerCodeStrict(raw).ok).toBe(false)
  })

  it('H1B-000 is out of range', () => {
    expect(parseHangerCodeStrict('H1B-000')).toMatchObject({ ok: false, error: 'out_of_range' })
  })

  it('rejects empty', () => {
    expect(parseHangerCodeStrict('')).toMatchObject({ ok: false, error: 'empty' })
  })

  it('rejects a 24-char Metrc tag with a specific reason', () => {
    expect(parseHangerCodeStrict(METRC)).toMatchObject({ ok: false, error: 'looks_like_metrc_tag' })
  })

  it('strict is stricter than lenient for the same text', () => {
    for (const typed of ['42', 'h1b42', 'H1B-42']) {
      expect(parseHangerCodeLenient(typed).ok).toBe(true)
      expect(parseHangerCodeStrict(typed).ok).toBe(false)
    }
  })
})

describe('isHangerCode', () => {
  it('is the strict check', () => {
    expect(isHangerCode('H1B-042')).toBe(true)
    expect(isHangerCode('h1b-042')).toBe(false)
    expect(isHangerCode('42')).toBe(false)
    expect(isHangerCode(METRC)).toBe(false)
  })
})

describe('round trip', () => {
  it('every canonical code parses back to its number in both modes', () => {
    for (let n = 1; n <= 999; n++) {
      const code = formatHangerCode(n)
      expect(parseHangerCodeStrict(code)).toMatchObject({ ok: true, seq: n, code })
      expect(parseHangerCodeLenient(code)).toMatchObject({ ok: true, seq: n, code })
      expect(parseHangerCodeLenient(String(n))).toMatchObject({ ok: true, seq: n, code })
    }
  })
})
