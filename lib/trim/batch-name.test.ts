import { describe, expect, it } from 'vitest'
import {
  abbreviationFromBatchName,
  abbreviationFromSkuCode,
  abbreviationFromStrainName,
  createBatchNameAllocator,
  deriveStrainAbbreviation,
  formatBatchName,
  suggestBatchName,
} from './batch-name'

describe('formatBatchName', () => {
  it('MMDD-F{room}-{ABBR}', () => {
    expect(formatBatchName({ harvestDate: '2026-07-23', roomNumber: 1, abbreviation: 'CM' })).toBe('0723-F1-CM')
    expect(formatBatchName({ harvestDate: '2026-10-29', roomNumber: 5, abbreviation: 'gg4' })).toBe('1029-F5-GG4')
  })
  it('does not shift across timezones (string, not Date)', () => {
    expect(formatBatchName({ harvestDate: '2026-01-01', roomNumber: 2, abbreviation: 'ab' })).toBe('0101-F2-AB')
    expect(formatBatchName({ harvestDate: '2026-12-31', roomNumber: 2, abbreviation: 'ab' })).toBe('1231-F2-AB')
  })
  it('accepts a timestamp prefix', () => {
    expect(formatBatchName({ harvestDate: '2026-07-23T05:30:00Z', roomNumber: 1, abbreviation: 'CM' })).toBe('0723-F1-CM')
  })
  it('strips non-alphanumerics from the abbreviation', () => {
    expect(formatBatchName({ harvestDate: '2026-07-23', roomNumber: 1, abbreviation: ' c-m! ' })).toBe('0723-F1-CM')
  })
  it.each(['', '2026-13-01', '2026-00-10', '2026-07-32', '07/23/2026', 'garbage'])('rejects date %j', (d) => {
    expect(() => formatBatchName({ harvestDate: d, roomNumber: 1, abbreviation: 'CM' })).toThrow(RangeError)
  })
  it.each([0, -1, 1.5, NaN])('rejects room %s', (r) => {
    expect(() => formatBatchName({ harvestDate: '2026-07-23', roomNumber: r, abbreviation: 'CM' })).toThrow(RangeError)
  })
  it('rejects an empty abbreviation', () => {
    expect(() => formatBatchName({ harvestDate: '2026-07-23', roomNumber: 1, abbreviation: '--' })).toThrow(RangeError)
  })
})

describe('abbreviationFromBatchName', () => {
  it.each([
    ['0723-F1-CM', 'CM'],
    ['0622-F5-cm', 'CM'],
    ['0622-F5-CM-2', 'CM'],
    ['0622-F5-CM-3', 'CM'],
    ['0622-F5-CM-2-3', 'CM'],
    ['0723-F!-CM', 'CM'], // the live typo still yields its abbreviation
    ['  0723-F1-GG4  ', 'GG4'],
  ])('%j -> %s', (name, abbr) => {
    expect(abbreviationFromBatchName(name)).toBe(abbr)
  })
  it.each([
    'Test batch',
    'CM',
    '0723-F1',
    '0723-F1-',
    '0723-F1-TOOLONGABBR',
    '0723-F1-420',
    '723-F1-CM',
    '',
  ])('%j -> null', (name) => {
    expect(abbreviationFromBatchName(name)).toBeNull()
  })
})

describe('abbreviationFromSkuCode', () => {
  it('takes the leading token', () => {
    expect(abbreviationFromSkuCode('CM-3.5-8')).toBe('CM')
    expect(abbreviationFromSkuCode('cm_eighth')).toBe('CM')
  })
  it('null for unusable or missing codes', () => {
    expect(abbreviationFromSkuCode('CHERRYMINTZ-EIGHTH')).toBeNull()
    expect(abbreviationFromSkuCode('420')).toBeNull()
    expect(abbreviationFromSkuCode('')).toBeNull()
    expect(abbreviationFromSkuCode(null)).toBeNull()
    expect(abbreviationFromSkuCode(undefined)).toBeNull()
  })
})

describe('abbreviationFromStrainName (initials)', () => {
  it.each([
    ['Cherry Mintz', 'CM'],
    ['cherry mintz', 'CM'],
    ['Blue Dream Haze', 'BDH'],
    ['Gelato 41', 'G41'],
    ['Zkittlez', 'ZK'],
    ['Wedding-Cake', 'WC'],
    ['  Do  Si  Dos ', 'DSD'],
    ['Z', 'Z'],
    ['Very Long Strain Name Here Now Ok', 'VLSNHN'],
    ['', 'XX'],
    ['***', 'XX'],
  ])('%j -> %s', (name, abbr) => {
    expect(abbreviationFromStrainName(name)).toBe(abbr)
  })
})

describe('deriveStrainAbbreviation: priority order', () => {
  const strainName = 'Cherry Mintz'

  it('1. batch history wins over sku code and initials', () => {
    expect(
      deriveStrainAbbreviation({
        strainName,
        strainBatches: [{ name: '0501-F1-CMZ', createdAt: '2026-05-01T00:00:00Z' }],
        skuCodes: ['XY-1'],
      })
    ).toEqual({ abbreviation: 'CMZ', source: 'batch_history' })
  })

  it('uses the MOST RECENT batch when abbreviations differ', () => {
    const r = deriveStrainAbbreviation({
      strainName,
      strainBatches: [
        { name: '0301-F1-OLD', createdAt: '2026-03-01T00:00:00Z' },
        { name: '0901-F1-NEW', createdAt: '2026-09-01T00:00:00Z' },
        { name: '0601-F1-MID', createdAt: '2026-06-01T00:00:00Z' },
      ],
    })
    expect(r).toEqual({ abbreviation: 'NEW', source: 'batch_history' })
  })

  it('without timestamps, the first ref is the newest', () => {
    const r = deriveStrainAbbreviation({
      strainName,
      strainBatches: [{ name: '0901-F1-AA' }, { name: '0301-F1-BB' }],
    })
    expect(r.abbreviation).toBe('AA')
  })

  it('a dated ref beats an undated one', () => {
    const r = deriveStrainAbbreviation({
      strainName,
      strainBatches: [{ name: '0901-F1-AA', createdAt: null }, { name: '0301-F1-BB', createdAt: '2026-03-01T00:00:00Z' }],
    })
    expect(r.abbreviation).toBe('BB')
  })

  it('2. falls to the sku code when the latest batch name is unusable', () => {
    expect(
      deriveStrainAbbreviation({
        strainName,
        strainBatches: [{ name: 'Test batch', createdAt: '2026-05-01T00:00:00Z' }],
        skuCodes: [null, 'CHERRYMINTZ-X', 'cm-35'],
      })
    ).toEqual({ abbreviation: 'CM', source: 'sku_code' })
  })

  it('2. sku code with no batch history', () => {
    expect(deriveStrainAbbreviation({ strainName, skuCodes: ['CM-35'] })).toEqual({
      abbreviation: 'CM',
      source: 'sku_code',
    })
  })

  it('3. falls to initials', () => {
    expect(deriveStrainAbbreviation({ strainName })).toEqual({ abbreviation: 'CM', source: 'initials' })
    expect(deriveStrainAbbreviation({ strainName, strainBatches: [], skuCodes: [] })).toEqual({
      abbreviation: 'CM',
      source: 'initials',
    })
  })

  it('only looks at the most recent batch, not older ones, before moving on', () => {
    const r = deriveStrainAbbreviation({
      strainName,
      strainBatches: [
        { name: 'junk', createdAt: '2026-09-01T00:00:00Z' },
        { name: '0301-F1-OLD', createdAt: '2026-03-01T00:00:00Z' },
      ],
    })
    expect(r.source).toBe('initials')
  })
})

describe('collision suffix', () => {
  it('returns the base when free', () => {
    expect(createBatchNameAllocator([]).allocate('0723-F1-CM')).toBe('0723-F1-CM')
  })
  it('appends -2 when taken, then -3', () => {
    const a = createBatchNameAllocator(['0723-F1-CM'])
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM-2')
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM-3')
  })
  it('skips suffixes that already exist', () => {
    const a = createBatchNameAllocator(['0723-F1-CM', '0723-F1-CM-2'])
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM-3')
  })
  it('is case-insensitive and ignores surrounding whitespace', () => {
    const a = createBatchNameAllocator([' 0723-f1-cm '])
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM-2')
  })
  it('declaring the same strain twice in one dialog gives base then -2', () => {
    const a = createBatchNameAllocator(['0101-F1-ZZ'])
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM')
    expect(a.allocate('0723-F1-CM')).toBe('0723-F1-CM-2')
    expect(a.allocate('0723-F1-GG')).toBe('0723-F1-GG')
  })
  it('isTaken reflects existing and allocated names', () => {
    const a = createBatchNameAllocator(['A-1'])
    expect(a.isTaken('a-1')).toBe(true)
    expect(a.isTaken('B-1')).toBe(false)
    a.allocate('B-1')
    expect(a.isTaken('B-1')).toBe(true)
  })
  it('accepts any iterable and handles a large existing set', () => {
    const existing = new Set(Array.from({ length: 5000 }, (_, i) => `0101-F1-S${i}`))
    expect(createBatchNameAllocator(existing).allocate('0101-F1-S42')).toBe('0101-F1-S42-2')
  })
})

describe('suggestBatchName', () => {
  it('formats and de-collides in one call', () => {
    const parts = { harvestDate: '2026-10-29', roomNumber: 5, abbreviation: 'CM' }
    expect(suggestBatchName(parts, [])).toBe('1029-F5-CM')
    expect(suggestBatchName(parts, ['1029-F5-CM'])).toBe('1029-F5-CM-2')
  })
})
