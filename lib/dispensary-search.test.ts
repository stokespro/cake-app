import { describe, expect, it } from 'vitest'
import {
  buildSearchIndex,
  normalizeLicence,
  prepareQuery,
  searchDispensaries,
} from './dispensary-search'

/**
 * Shapes taken from real rows in the vault project, because the awkward cases
 * here are real: a trading name that shares nothing with the licensed entity
 * name, and licences that people type with, without, or with partial
 * punctuation.
 */
const POINTS = [
  {
    id: 'health-center',
    name: 'THE HEALTH CENTER 918 LLC',
    license_name: 'THE HEALTH CENTER 918 LLC',
    omma_license: 'DAAA-4YAE-YRGF',
  },
  {
    id: 'high-rise',
    name: 'High Rise',
    license_name: 'HIGH RISE ENTERPRISES INC.',
    omma_license: 'DAAA-1GPR-S65L',
  },
  {
    id: 'okie-riverside',
    name: 'OKIE Riverside - A-Z dispensary LLC',
    license_name: 'A-Z DISPENSARY',
    omma_license: 'DAAA-MOPH-ZNJ2',
  },
  {
    id: 'no-licence',
    name: 'Nameless Co',
    license_name: null,
    omma_license: null,
  },
]

const index = buildSearchIndex(POINTS)
const search = (q: string, limit = 10) => searchDispensaries(index, q, limit)
const ids = (q: string) => search(q).hits.map((h) => h.point.id)

describe('normalizeLicence', () => {
  it('reduces punctuation and case to a comparable form', () => {
    expect(normalizeLicence('DAAA-4YAE-YRGF')).toBe('daaa4yaeyrgf')
    expect(normalizeLicence('daaa 4yae yrgf')).toBe('daaa4yaeyrgf')
    expect(normalizeLicence('DAAA4YAEYRGF')).toBe('daaa4yaeyrgf')
  })

  it('handles null and undefined', () => {
    expect(normalizeLicence(null)).toBe('')
    expect(normalizeLicence(undefined)).toBe('')
  })
})

describe('prepareQuery', () => {
  it('returns null for blank input so callers can skip the scan', () => {
    expect(prepareQuery('')).toBeNull()
    expect(prepareQuery('   ')).toBeNull()
  })

  it('splits the query into text and punctuation-stripped forms', () => {
    expect(prepareQuery('  DAAA-4YAE ')).toEqual({
      text: 'daaa-4yae',
      bare: 'daaa4yae',
    })
  })
})

describe('OMMA licence matching', () => {
  // The question that prompted this file: does the licence still match when
  // typed exactly as stored, hyphens and all?
  it('matches the licence exactly as it is stored', () => {
    expect(ids('DAAA-4YAE-YRGF')).toEqual(['health-center'])
  })

  it.each([
    ['lowercased with hyphens', 'daaa-4yae-yrgf'],
    ['no punctuation', 'DAAA4YAEYRGF'],
    ['spaces instead of hyphens', 'daaa 4yae yrgf'],
    ['leading and trailing space', '  DAAA-4YAE-YRGF  '],
    ['first two blocks', 'DAAA-4YAE'],
    ['middle block only', '4YAE'],
  ])('matches when typed %s', (_label, query) => {
    expect(ids(query)).toEqual(['health-center'])
  })

  it('reports the licence as the matched field', () => {
    expect(search('DAAA-4YAE-YRGF').hits[0].matchedOn).toBe('omma_license')
  })

  it('never matches on licence for a punctuation-only query', () => {
    // A bare "-" normalises to '' for the licence comparison, and '' is a
    // substring of every licence — without the `query.bare` guard this would
    // return every row as an OMMA hit. A name that genuinely contains a hyphen
    // ("OKIE Riverside - A-Z dispensary LLC") is still a legitimate name match,
    // so the assertion is about the field, not the count.
    for (const query of ['-', '--- ---', '.']) {
      const matched = search(query).hits.map((h) => h.matchedOn)
      expect(matched).not.toContain('omma_license')
    }
    expect(search('-').total).toBe(1)
  })

  it('ignores rows with no licence', () => {
    expect(ids('daaa')).not.toContain('no-licence')
  })
})

describe('name and license-name matching', () => {
  it('finds a dispensary by its trading name', () => {
    expect(ids('health center')).toEqual(['health-center'])
  })

  it('finds one by licensed entity name when the trading name differs', () => {
    // "High Rise" alone never contains "enterprises".
    const hits = search('enterprises').hits
    expect(hits.map((h) => h.point.id)).toEqual(['high-rise'])
    expect(hits[0].matchedOn).toBe('license_name')
  })

  it('matches a substring from the middle, not just a prefix', () => {
    expect(ids('riverside')).toEqual(['okie-riverside'])
  })

  it('is case insensitive', () => {
    expect(ids('HIGH RISE')).toEqual(['high-rise'])
  })

  it('prefers the trading name when both could match', () => {
    // "A-Z dispensary" appears in the trading name and the licence name; the
    // trading name wins so the row needs no explanatory second line.
    expect(search('a-z dispensary').hits[0].matchedOn).toBe('name')
  })

  it('tolerates a null license name', () => {
    expect(ids('nameless')).toEqual(['no-licence'])
  })
})

describe('result capping', () => {
  it('caps hits but keeps counting the rest', () => {
    const result = searchDispensaries(index, 'daaa', 2)
    expect(result.hits).toHaveLength(2)
    // Three of the four rows carry a DAAA licence.
    expect(result.total).toBe(3)
  })

  it('returns nothing for a blank query rather than everything', () => {
    expect(search('')).toEqual({ hits: [], total: 0 })
    expect(search('   ')).toEqual({ hits: [], total: 0 })
  })

  it('returns nothing when there is no match', () => {
    expect(search('zzzznotathing')).toEqual({ hits: [], total: 0 })
  })
})
