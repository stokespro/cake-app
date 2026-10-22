import { describe, expect, it } from 'vitest'
import type { TrimDayEpisode } from '@/actions/trim-reports'
import {
  buildDisplayItems,
  compareEpisodes,
  defaultSort,
  limitDisplayItems,
  nextSort,
  resolveSort,
  showsSubtotals,
  sortEpisodes,
  subtotalOf,
  type SortKey,
} from './report-table'

const T_ANTONIO = 't-antonio'
const T_WAYNE = 't-wayne'
const T_MARIA = 't-maria'

let n = 0
function ep(over: Partial<TrimDayEpisode> = {}): TrimDayEpisode {
  n++
  return {
    checkoutId: `co-${String(n).padStart(4, '0')}`,
    seq: 1,
    hangerCode: 'H1B-001',
    loadId: `load-${n}`,
    batchId: 'b1',
    batchName: '1001-F1-BB',
    strainName: 'Bubble Bath',
    trimmerId: T_ANTONIO,
    trimmerName: 'Antonio',
    checkedOutAt: '2026-10-21T13:00:00+00:00',
    returnedAt: '2026-10-21T14:00:00+00:00',
    turnaroundHours: 1,
    issuedG: 600,
    flowerG: 250,
    trimG: 100,
    stemsG: 200,
    returnedTotalG: 550,
    varianceG: 5,
    variancePct: 0.8,
    varianceStatus: 'ok',
    returnKind: 'complete',
    ratePerLb: 225,
    payAmount: 50,
    ...over,
  }
}

const codes = (xs: TrimDayEpisode[]) => xs.map((e) => e.hangerCode)
const sort = (xs: TrimDayEpisode[], key: SortKey, dir: 'asc' | 'desc') => codes(sortEpisodes(xs, { key, dir }))

describe('compareEpisodes: every column sorts', () => {
  const a = ep({ hangerCode: 'H1B-002', batchName: '1001-F1-VZ', trimmerName: 'Wayne', trimmerId: T_WAYNE, checkedOutAt: '2026-10-21T15:00:00+00:00', issuedG: 700, flowerG: 300, trimG: 90, stemsG: 150, variancePct: 3, varianceG: 21, varianceStatus: 'accepted', payAmount: 70 })
  const b = ep({ hangerCode: 'H1B-010', batchName: '1001-F1-BB', trimmerName: 'Antonio', trimmerId: T_ANTONIO, checkedOutAt: '2026-10-21T13:00:00+00:00', issuedG: 500, flowerG: 100, trimG: 120, stemsG: 250, variancePct: 1, varianceG: 5, varianceStatus: 'ok', payAmount: 20 })
  const c = ep({ hangerCode: 'H1B-003', batchName: '1001-F1-CC', trimmerName: 'Maria', trimmerId: T_MARIA, checkedOutAt: '2026-10-21T14:00:00+00:00', issuedG: 600, flowerG: 200, trimG: 100, stemsG: 200, variancePct: 2, varianceG: 12, varianceStatus: 'flagged', payAmount: 40 })
  const rows = [a, b, c]

  it.each<[SortKey, string[]]>([
    ['hanger', ['H1B-002', 'H1B-003', 'H1B-010']],
    ['batch', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['trimmer', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['outIn', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['issued', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['flower', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['trim', ['H1B-002', 'H1B-003', 'H1B-010']],
    ['stems', ['H1B-002', 'H1B-003', 'H1B-010']],
    ['variance', ['H1B-010', 'H1B-003', 'H1B-002']],
    ['status', ['H1B-003', 'H1B-002', 'H1B-010']], // flagged, accepted, in threshold
    ['pay', ['H1B-010', 'H1B-003', 'H1B-002']],
  ])('%s ascending', (key, expected) => {
    expect(sort(rows, key, 'asc')).toEqual(expected)
  })

  it.each<SortKey>(['hanger', 'batch', 'trimmer', 'outIn', 'issued', 'flower', 'trim', 'stems', 'variance', 'status', 'pay'])(
    '%s descending is the exact reverse of ascending',
    (key) => {
      expect(sort(rows, key, 'desc')).toEqual(sort(rows, key, 'asc').reverse())
    }
  )

  it('hanger codes sort naturally (H1B-9 before H1B-10)', () => {
    const xs = [ep({ hangerCode: 'H1B-10' }), ep({ hangerCode: 'H1B-9' }), ep({ hangerCode: 'H1B-100' })]
    expect(sort(xs, 'hanger', 'asc')).toEqual(['H1B-9', 'H1B-10', 'H1B-100'])
  })

  it('trimmer names sort case-insensitively', () => {
    const xs = [ep({ hangerCode: 'b', trimmerName: 'bea', trimmerId: 'x1' }), ep({ hangerCode: 'a', trimmerName: 'Aaron', trimmerId: 'x2' })]
    expect(sort(xs, 'trimmer', 'asc')).toEqual(['a', 'b'])
  })
})

describe('Variance sorts by magnitude: the anomaly floats to the top', () => {
  const rows = [
    ep({ hangerCode: 'H1B-044', variancePct: 0.9, varianceG: 5.4 }),
    ep({ hangerCode: 'H1B-054', trimmerName: 'Wayne', trimmerId: T_WAYNE, variancePct: 29.86, varianceG: 180 }), // shown as -29.86%
    ep({ hangerCode: 'H1B-061', variancePct: -4.2, varianceG: -25 }), // a gain: shown as +4.2%
    ep({ hangerCode: 'H1B-070', variancePct: 2.4, varianceG: 18 }),
  ]
  it('descending puts H1B-054 (-29.86% as displayed) first', () => {
    expect(sort(rows, 'variance', 'desc')[0]).toBe('H1B-054')
    expect(sort(rows, 'variance', 'desc')).toEqual(['H1B-054', 'H1B-061', 'H1B-070', 'H1B-044'])
  })
  it('a large gain ranks beside a large loss, not at the opposite end', () => {
    const withGain = [...rows, ep({ hangerCode: 'GAIN', variancePct: -31, varianceG: -200 })]
    expect(sort(withGain, 'variance', 'desc').slice(0, 2)).toEqual(['GAIN', 'H1B-054'])
  })
  it('falls back to grams when there is no percentage', () => {
    const xs = [ep({ hangerCode: 'a', variancePct: null, varianceG: 10 }), ep({ hangerCode: 'b', variancePct: null, varianceG: -40 })]
    expect(sort(xs, 'variance', 'desc')).toEqual(['b', 'a'])
  })
})

describe('nulls sort last in both directions', () => {
  const rows = [
    ep({ hangerCode: 'none', flowerG: null, payAmount: null, variancePct: null, varianceG: null, varianceStatus: null, batchName: null, checkedOutAt: null }),
    ep({ hangerCode: 'lo', flowerG: 10, payAmount: 5, variancePct: 1, batchName: 'A', checkedOutAt: '2026-10-21T10:00:00+00:00' }),
    ep({ hangerCode: 'hi', flowerG: 90, payAmount: 9, variancePct: 5, varianceStatus: 'flagged', batchName: 'B', checkedOutAt: '2026-10-21T11:00:00+00:00' }),
  ]
  it.each<SortKey>(['flower', 'pay', 'variance', 'status', 'batch', 'outIn'])('%s', (key) => {
    expect(sort(rows, key, 'asc').at(-1)).toBe('none')
    expect(sort(rows, key, 'desc').at(-1)).toBe('none')
  })
  it('real values still flip with the direction', () => {
    expect(sort(rows, 'flower', 'asc')).toEqual(['lo', 'hi', 'none'])
    expect(sort(rows, 'flower', 'desc')).toEqual(['hi', 'lo', 'none'])
  })
  it('a zero is a value, not a null', () => {
    const xs = [ep({ hangerCode: 'null', flowerG: null }), ep({ hangerCode: 'zero', flowerG: 0 }), ep({ hangerCode: 'ten', flowerG: 10 })]
    expect(sort(xs, 'flower', 'asc')).toEqual(['zero', 'ten', 'null'])
    expect(sort(xs, 'flower', 'desc')).toEqual(['ten', 'zero', 'null'])
  })
  it('two nulls fall back to checkout time', () => {
    const xs = [
      ep({ hangerCode: 'late', flowerG: null, checkedOutAt: '2026-10-21T18:00:00+00:00' }),
      ep({ hangerCode: 'early', flowerG: null, checkedOutAt: '2026-10-21T09:00:00+00:00' }),
    ]
    expect(sort(xs, 'flower', 'desc')).toEqual(['early', 'late'])
  })
})

describe('tie-breaking', () => {
  it('ties on the sort column fall back to checkout time ascending in either direction', () => {
    const xs = [
      ep({ hangerCode: 'c', trimmerName: 'Antonio', checkedOutAt: '2026-10-21T17:00:00+00:00' }),
      ep({ hangerCode: 'a', trimmerName: 'Antonio', checkedOutAt: '2026-10-21T09:00:00+00:00' }),
      ep({ hangerCode: 'b', trimmerName: 'Antonio', checkedOutAt: '2026-10-21T12:00:00+00:00' }),
    ]
    expect(sort(xs, 'trimmer', 'asc')).toEqual(['a', 'b', 'c'])
    expect(sort(xs, 'trimmer', 'desc')).toEqual(['a', 'b', 'c'])
  })
  it('two people with the same name stay in separate blocks', () => {
    const xs = [
      ep({ hangerCode: '1', trimmerName: 'Sam', trimmerId: 's2', checkedOutAt: '2026-10-21T09:00:00+00:00' }),
      ep({ hangerCode: '2', trimmerName: 'Sam', trimmerId: 's1', checkedOutAt: '2026-10-21T10:00:00+00:00' }),
      ep({ hangerCode: '3', trimmerName: 'Sam', trimmerId: 's2', checkedOutAt: '2026-10-21T11:00:00+00:00' }),
    ]
    expect(sort(xs, 'trimmer', 'asc')).toEqual(['2', '1', '3'])
  })
  it('does not mutate its input', () => {
    const xs = [ep({ hangerCode: 'b', flowerG: 2 }), ep({ hangerCode: 'a', flowerG: 1 })]
    sortEpisodes(xs, { key: 'flower', dir: 'asc' })
    expect(codes(xs)).toEqual(['b', 'a'])
  })
  it('compareEpisodes is usable directly with Array.sort', () => {
    const xs = [ep({ hangerCode: 'b', flowerG: 2 }), ep({ hangerCode: 'a', flowerG: 1 })]
    expect(codes([...xs].sort(compareEpisodes({ key: 'flower', dir: 'asc' })))).toEqual(['a', 'b'])
  })
})

describe('default sort', () => {
  it('no trimmer selected: by trimmer (then checkout time) ascending', () => {
    expect(defaultSort(false)).toEqual({ key: 'trimmer', dir: 'asc' })
  })
  it('a trimmer selected: by checkout time ascending', () => {
    expect(defaultSort(true)).toEqual({ key: 'outIn', dir: 'asc' })
  })
  it('a crew day clusters by person, each person in checkout order', () => {
    const xs = [
      ep({ hangerCode: 'w1', trimmerName: 'Wayne', trimmerId: T_WAYNE, checkedOutAt: '2026-10-21T09:00:00+00:00' }),
      ep({ hangerCode: 'a2', trimmerName: 'Antonio', trimmerId: T_ANTONIO, checkedOutAt: '2026-10-21T11:00:00+00:00' }),
      ep({ hangerCode: 'a1', trimmerName: 'Antonio', trimmerId: T_ANTONIO, checkedOutAt: '2026-10-21T08:00:00+00:00' }),
      ep({ hangerCode: 'w2', trimmerName: 'Wayne', trimmerId: T_WAYNE, checkedOutAt: '2026-10-21T10:00:00+00:00' }),
    ]
    expect(codes(sortEpisodes(xs, defaultSort(false)))).toEqual(['a1', 'a2', 'w1', 'w2'])
  })
  it('one trimmer\'s day is chronological', () => {
    const xs = [
      ep({ hangerCode: 'late', checkedOutAt: '2026-10-21T16:00:00+00:00' }),
      ep({ hangerCode: 'early', checkedOutAt: '2026-10-21T08:00:00+00:00' }),
    ]
    expect(codes(sortEpisodes(xs, defaultSort(true)))).toEqual(['early', 'late'])
  })
})

describe('resolveSort: an explicit click wins and sticks until the filters change', () => {
  const click = { key: 'flower' as const, dir: 'desc' as const, filterSig: 'A' }
  it('no click: the default for the trimmer state', () => {
    expect(resolveSort(null, 'A', false)).toEqual(defaultSort(false))
    expect(resolveSort(null, 'A', true)).toEqual(defaultSort(true))
  })
  it('a click made under the current filters is used, whether or not a trimmer is selected', () => {
    expect(resolveSort(click, 'A', false)).toEqual({ key: 'flower', dir: 'desc' })
    expect(resolveSort(click, 'A', true)).toEqual({ key: 'flower', dir: 'desc' })
  })
  it('after the filters change, the default returns', () => {
    expect(resolveSort(click, 'B', false)).toEqual(defaultSort(false))
    expect(resolveSort(click, 'B', true)).toEqual(defaultSort(true))
  })
  it('the user\'s click does not leak its filter signature into the sort', () => {
    expect(Object.keys(resolveSort(click, 'A', false)).sort()).toEqual(['dir', 'key'])
  })
})

describe('nextSort (the orders-page interaction)', () => {
  it('a new column starts ascending', () => {
    expect(nextSort({ key: 'trimmer', dir: 'desc' }, 'flower')).toEqual({ key: 'flower', dir: 'asc' })
  })
  it('the same column flips direction', () => {
    expect(nextSort({ key: 'flower', dir: 'asc' }, 'flower')).toEqual({ key: 'flower', dir: 'desc' })
    expect(nextSort({ key: 'flower', dir: 'desc' }, 'flower')).toEqual({ key: 'flower', dir: 'asc' })
  })
  it('clicking Trimmer while on the default flips it to descending', () => {
    expect(nextSort(defaultSort(false), 'trimmer')).toEqual({ key: 'trimmer', dir: 'desc' })
  })
})

describe('subtotals', () => {
  /** Antonio, 2026-10-21 (the acceptance scenario). */
  const antonio = [
    ep({ loadId: 'l1', issuedG: 595, flowerG: 245, varianceG: 5.4, payAmount: 54.01 }),
    ep({ loadId: 'l2', issuedG: 480, flowerG: 194.2, varianceG: 11.6, payAmount: 42.81 }),
    ep({ loadId: 'l3', issuedG: 765, flowerG: 302.7, varianceG: 18.2, payAmount: 66.73 }),
    ep({ loadId: 'l4', issuedG: 615, flowerG: 268.5, varianceG: 20.1, payAmount: 59.19 }),
  ]

  it('sums hangers, issued, flower, variance and pay for the block', () => {
    expect(subtotalOf(antonio)).toEqual({
      trimmerId: T_ANTONIO,
      trimmerName: 'Antonio',
      hangers: 4,
      episodes: 4,
      issuedG: 2455,
      flowerG: 1010.4, // exactly, with no floating-point dust (245 + 194.2 + 302.7 + 268.5)
      varianceG: 55.3,
      payAmount: 222.74,
    })
  })

  it('sums pay in cents: ten lines of $0.10 are $1.00, not 0.9999999999999999', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ep({ loadId: `p${i}`, payAmount: 0.1 }))
    expect(subtotalOf(lines).payAmount).toBe(1)
  })

  it('counts a hanger once however many times it was returned', () => {
    const twice = [ep({ loadId: 'same', seq: 1 }), ep({ loadId: 'same', seq: 2 }), ep({ loadId: 'other' })]
    expect(subtotalOf(twice)).toMatchObject({ hangers: 2, episodes: 3 })
  })

  it('treats missing weights as zero and no pay lines as no pay', () => {
    const s = subtotalOf([ep({ issuedG: null, flowerG: null, varianceG: null, payAmount: null }), ep({ issuedG: 100, flowerG: 40, varianceG: 2, payAmount: null })])
    expect(s).toMatchObject({ issuedG: 100, flowerG: 40, varianceG: 2, payAmount: null })
  })

  it('a flagged hanger with no pay line adds nothing to pay but still counts as a hanger', () => {
    const s = subtotalOf([ep({ payAmount: 10 }), ep({ payAmount: null, varianceStatus: 'flagged' })])
    expect(s).toMatchObject({ hangers: 2, payAmount: 10 })
  })

  describe('buildDisplayItems', () => {
    const crew = [
      ...antonio,
      ep({ trimmerId: T_WAYNE, trimmerName: 'Wayne', loadId: 'w1', issuedG: 1000, flowerG: 400, payAmount: 90 }),
      ep({ trimmerId: T_WAYNE, trimmerName: 'Wayne', loadId: 'w2', issuedG: 500, flowerG: 100, payAmount: 30 }),
    ]
    const sorted = sortEpisodes(crew, defaultSort(false))

    it('puts a subtotal after each trimmer block when asked', () => {
      const items = buildDisplayItems(sorted, true)
      expect(items.map((i) => i.kind)).toEqual([
        'episode', 'episode', 'episode', 'episode', 'subtotal',
        'episode', 'episode', 'subtotal',
      ])
      const subs = items.filter((i) => i.kind === 'subtotal').map((i) => (i.kind === 'subtotal' ? i.subtotal : null))
      expect(subs.map((s) => [s!.trimmerName, s!.hangers, s!.issuedG, s!.flowerG, s!.payAmount])).toEqual([
        ['Antonio', 4, 2455, 1010.4, 222.74],
        ['Wayne', 2, 1500, 500, 120],
      ])
    })

    it('adds no subtotal when not asked (any order other than by trimmer)', () => {
      expect(buildDisplayItems(sortEpisodes(crew, { key: 'flower', dir: 'desc' }), false).every((i) => i.kind === 'episode')).toBe(true)
    })

    it('subtotals appear only when the sort is by trimmer', () => {
      expect(showsSubtotals({ key: 'trimmer', dir: 'asc' })).toBe(true)
      expect(showsSubtotals({ key: 'trimmer', dir: 'desc' })).toBe(true)
      for (const key of ['hanger', 'batch', 'outIn', 'issued', 'flower', 'trim', 'stems', 'variance', 'status', 'pay'] as const) {
        expect(showsSubtotals({ key, dir: 'asc' })).toBe(false)
      }
    })

    it('empty in, empty out', () => {
      expect(buildDisplayItems([], true)).toEqual([])
    })

    it('every episode appears exactly once, and the subtotals add up to the whole set', () => {
      const items = buildDisplayItems(sorted, true)
      expect(items.filter((i) => i.kind === 'episode')).toHaveLength(crew.length)
      const flower = items.reduce((t, i) => (i.kind === 'subtotal' ? t + i.subtotal.flowerG : t), 0)
      expect(flower).toBeCloseTo(crew.reduce((t, e) => t + (e.flowerG ?? 0), 0), 6)
    })
  })

  describe('limitDisplayItems: rendering a slice never changes a subtotal', () => {
    const many = Array.from({ length: 6 }, (_, i) => ep({ trimmerId: T_ANTONIO, trimmerName: 'Antonio', loadId: `a${i}`, flowerG: 100 })).concat(
      Array.from({ length: 4 }, (_, i) => ep({ trimmerId: T_WAYNE, trimmerName: 'Wayne', loadId: `w${i}`, flowerG: 50 }))
    )
    const items = buildDisplayItems(sortEpisodes(many, defaultSort(false)), true)

    it('cuts at the end of the block it falls in, so a subtotal always covers every row above it', () => {
      const cut = limitDisplayItems(items, 2)
      expect(cut.shownEpisodes).toBe(6) // the whole Antonio block, not 2
      expect(cut.items.at(-1)?.kind).toBe('subtotal')
      const sub = cut.items.at(-1)
      expect(sub?.kind === 'subtotal' && sub.subtotal).toMatchObject({ hangers: 6, flowerG: 600 })
    })

    it('the subtotal is identical whether or not the list was cut', () => {
      const whole = items.find((i) => i.kind === 'subtotal')
      const cut = limitDisplayItems(items, 1).items.find((i) => i.kind === 'subtotal')
      expect(cut).toEqual(whole)
    })

    it('shows everything when the limit is large', () => {
      expect(limitDisplayItems(items, 1000)).toEqual({ items, shownEpisodes: 10 })
    })

    it('without subtotals the cut is exact', () => {
      const flat = buildDisplayItems(sortEpisodes(many, { key: 'flower', dir: 'desc' }), false)
      const cut = limitDisplayItems(flat, 3)
      expect(cut.shownEpisodes).toBe(3)
      expect(cut.items).toHaveLength(3)
    })
  })
})
