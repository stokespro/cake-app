import { describe, expect, it } from 'vitest'
import {
  optionCount,
  batchOptionLabel,
  deriveBatchOptions,
  deriveTrimmerOptions,
  emptyReportMessage,
  narrowByBatch,
  narrowByTrimmer,
  trimmerOptionLabel,
  withSelectedOption,
  type ActivityRow,
} from './report-options'

let n = 0
function act(over: Partial<ActivityRow> = {}): ActivityRow {
  n++
  return {
    status: 'returned',
    loadId: `load-${n}`,
    batchId: 'b-bb',
    batchName: '1001-F1-BB',
    strainName: 'Bubble Bath',
    harvestDate: '2026-10-01',
    trimmerId: 't-antonio',
    trimmerName: 'Antonio',
    checkedOutAt: '2026-10-21T13:00:00+00:00',
    ...over,
  }
}
const VZ = { batchId: 'b-vz', batchName: '1001-F1-VZ', strainName: 'VerZace', harvestDate: '2026-09-20' }
const MARIA = { trimmerId: 't-maria', trimmerName: 'Maria' }

describe('deriveBatchOptions', () => {
  it('counts distinct hangers per batch, newest harvest first, undated last', () => {
    const rows = [
      act({ loadId: 'a' }), act({ loadId: 'b' }), act({ loadId: 'b' }),
      act({ ...VZ, loadId: 'c' }),
      act({ batchId: 'b-old', batchName: '0801', strainName: null, harvestDate: null, loadId: 'd' }),
    ]
    expect(deriveBatchOptions(rows)).toEqual([
      { id: 'b-bb', name: '1001-F1-BB', strainName: 'Bubble Bath', harvestDate: '2026-10-01', hangers: 2, returnedHangers: 2 },
      { id: 'b-vz', name: '1001-F1-VZ', strainName: 'VerZace', harvestDate: '2026-09-20', hangers: 1, returnedHangers: 1 },
      { id: 'b-old', name: '0801', strainName: null, harvestDate: null, hangers: 1, returnedHangers: 1 },
    ])
  })

  it('open and returned work both make a batch active', () => {
    expect(deriveBatchOptions([act({ status: 'out' })])).toHaveLength(1)
  })

  it('rows with no batch add no option and nothing throws', () => {
    expect(deriveBatchOptions([act({ batchId: null, batchName: null })])).toEqual([])
    expect(deriveBatchOptions([])).toEqual([])
  })
})

describe('deriveTrimmerOptions', () => {
  it('A to Z with distinct hanger counts', () => {
    const rows = [act({ ...MARIA, loadId: 'm' }), act({ loadId: 'a1' }), act({ loadId: 'a2' }), act({ loadId: 'a2' })]
    expect(deriveTrimmerOptions(rows)).toEqual([
      { id: 't-antonio', name: 'Antonio', hangers: 2, returnedHangers: 2 },
      { id: 't-maria', name: 'Maria', hangers: 1, returnedHangers: 1 },
    ])
  })
})

describe('option counts: all assigned work vs returned only', () => {
  // Antonio: two returned hangers and one still out. Maria: nothing but an open hanger.
  const rows = [
    act({ loadId: 'a1' }),
    act({ loadId: 'a2' }),
    act({ loadId: 'a3', status: 'out' }),
    act({ ...MARIA, loadId: 'm1', status: 'out' }),
  ]

  it('trimmers: `hangers` counts open work, `returnedHangers` does not', () => {
    expect(deriveTrimmerOptions(rows).map((o) => [o.name, o.hangers, o.returnedHangers])).toEqual([
      ['Antonio', 3, 2],
      ['Maria', 1, 0],
    ])
  })

  it('batches: same split', () => {
    expect(deriveBatchOptions(rows).map((o) => [o.hangers, o.returnedHangers])).toEqual([[4, 2]])
  })

  it('the option LIST is the same whichever count is shown: a trimmer with only open work is still listed (as 0 when finished only)', () => {
    const maria = deriveTrimmerOptions(rows).find((o) => o.id === 't-maria')!
    expect(maria).toBeDefined()
    expect(optionCount(maria, true)).toBe(0)
    expect(optionCount(maria, false)).toBe(1)
    expect(trimmerOptionLabel(maria, true)).toBe('Maria (0)')
    expect(trimmerOptionLabel(maria, false)).toBe('Maria (1)')
  })

  it('a hanger returned once and checked out again counts once in each mode, and as returned', () => {
    const reissued = [act({ loadId: 'x' }), act({ loadId: 'x', status: 'out' })]
    expect(deriveTrimmerOptions(reissued)[0]).toMatchObject({ hangers: 1, returnedHangers: 1 })
  })

  it('finished-only counts agree with the Hangers tile: distinct returned hangers among the rows that selecting the option leaves', () => {
    for (const t of deriveTrimmerOptions(rows)) {
      const left = narrowByTrimmer(rows, t.id).filter((r) => r.status === 'returned')
      expect(new Set(left.map((r) => r.loadId)).size).toBe(optionCount(t, true))
    }
  })
})

describe('trimmer names across a range', () => {
  it('uses the most recent recorded name, whatever order the rows come in', () => {
    const old = act({ trimmerName: 'Antonio D', checkedOutAt: '2026-10-19T13:00:00+00:00' })
    const recent = act({ trimmerName: 'Antonio', checkedOutAt: '2026-10-21T13:00:00+00:00' })
    expect(deriveTrimmerOptions([old, recent])[0].name).toBe('Antonio')
    expect(deriveTrimmerOptions([recent, old])[0].name).toBe('Antonio')
  })
})

describe('one-way cascade: Date -> Batch -> Trimmer', () => {
  const day = [
    act({ loadId: 'a1' }), act({ loadId: 'a2', ...VZ }), act({ ...MARIA, loadId: 'm1' }),
    act({ ...MARIA, loadId: 'm2', status: 'out' }),
  ]

  it('batch options never depend on the trimmer or batch selection (they are built from the date-range set)', () => {
    const ids = (rows: ActivityRow[]) => deriveBatchOptions(rows).map((o) => o.id)
    expect(ids(day)).toEqual(['b-bb', 'b-vz'])
    // Narrowing by trimmer first would change the result; the action therefore derives batches BEFORE narrowing.
    expect(ids(narrowByTrimmer(day, 't-maria'))).toEqual(['b-bb'])
  })

  it('trimmer options follow the batch', () => {
    expect(deriveTrimmerOptions(narrowByBatch(day, 'b-vz')).map((o) => o.name)).toEqual(['Antonio'])
    expect(deriveTrimmerOptions(narrowByBatch(day, 'b-bb')).map((o) => [o.name, o.hangers])).toEqual([['Antonio', 1], ['Maria', 2]])
    expect(deriveTrimmerOptions(narrowByBatch(day, null))).toHaveLength(2)
  })

  it('INVARIANT: every offered option narrows to exactly its count of hangers, never zero', () => {
    for (const b of deriveBatchOptions(day)) {
      const rows = narrowByBatch(day, b.id)
      expect(new Set(rows.map((r) => r.loadId)).size).toBe(b.hangers)
      for (const t of deriveTrimmerOptions(rows)) {
        const both = narrowByTrimmer(rows, t.id)
        expect(both.length).toBeGreaterThan(0)
        expect(new Set(both.map((r) => r.loadId)).size).toBe(t.hangers)
      }
    }
  })
})

describe('withSelectedOption: a selection is kept, not dropped', () => {
  const list = [{ id: 'a', hangers: 3, returnedHangers: 2 }]
  const make = (id: string) => ({ id, hangers: 0, returnedHangers: 0 })
  it('adds the missing selection with a zero count', () => {
    expect(withSelectedOption(list, 'z', make)).toEqual([{ id: 'a', hangers: 3, returnedHangers: 2 }, { id: 'z', hangers: 0, returnedHangers: 0 }])
  })
  it('leaves the list alone when the selection is already there or nothing is selected', () => {
    expect(withSelectedOption(list, 'a', make)).toEqual(list)
    expect(withSelectedOption(list, null, make)).toEqual(list)
  })
  it('does not mutate its input', () => {
    withSelectedOption(list, 'z', make)
    expect(list).toHaveLength(1)
  })
})

describe('labels', () => {
  it('trimmer: name and count', () => {
    expect(trimmerOptionLabel({ name: 'Antonio', hangers: 4, returnedHangers: 4 }, true)).toBe('Antonio (4)')
    expect(trimmerOptionLabel({ name: 'Antonio', hangers: 0, returnedHangers: 0 }, true)).toBe('Antonio (0)')
  })
  it('batch: name, strain and count', () => {
    expect(batchOptionLabel({ name: '1001-F1-BB', strainName: 'Bubble Bath', hangers: 18, returnedHangers: 18 }, true)).toBe('1001-F1-BB — Bubble Bath (18)')
    expect(batchOptionLabel({ name: '1001-F1-BB', strainName: null, hangers: 2, returnedHangers: 2 }, true)).toBe('1001-F1-BB (2)')
  })
  it('the count follows the toggle: returned only when finished only, all assigned work otherwise', () => {
    expect(trimmerOptionLabel({ name: 'Antonio', hangers: 17, returnedHangers: 4 }, true)).toBe('Antonio (4)')
    expect(trimmerOptionLabel({ name: 'Antonio', hangers: 17, returnedHangers: 4 }, false)).toBe('Antonio (17)')
    expect(batchOptionLabel({ name: '1001-F1-BB', strainName: 'Bubble Bath', hangers: 17, returnedHangers: 4 }, true)).toBe('1001-F1-BB — Bubble Bath (4)')
    expect(batchOptionLabel({ name: '1001-F1-BB', strainName: 'Bubble Bath', hangers: 17, returnedHangers: 4 }, false)).toBe('1001-F1-BB — Bubble Bath (17)')
  })
})

describe('emptyReportMessage: says why the table is empty', () => {
  const batchOptions = [
    { id: 'b-bb', name: '1001-F1-BB', strainName: 'Bubble Bath', harvestDate: null, hangers: 5, returnedHangers: 5 },
    { id: 'b-none', name: '0901-OLD', strainName: null, harvestDate: null, hangers: 0, returnedHangers: 0 },
  ]
  const trimmerOptions = [
    { id: 't-antonio', name: 'Antonio', hangers: 0, returnedHangers: 0 },
    { id: 't-maria', name: 'Maria', hangers: 2, returnedHangers: 2 },
  ]
  const sel = { batchId: null, trimmerId: null, batchOptions, trimmerOptions }

  it('a trimmer with nothing: names them', () => {
    expect(emptyReportMessage({ ...sel, trimmerId: 't-antonio' })).toBe(
      'Antonio has no returned or checked-out hangers in the selected range.'
    )
  })
  it('a trimmer with nothing on a chosen batch: names both', () => {
    expect(emptyReportMessage({ ...sel, trimmerId: 't-antonio', batchId: 'b-bb' })).toBe(
      'Antonio has no returned or checked-out hangers on batch 1001-F1-BB in the selected range.'
    )
  })
  it('a batch with nothing in the range: names the batch (it explains the trimmer too)', () => {
    expect(emptyReportMessage({ ...sel, batchId: 'b-none', trimmerId: 't-antonio' })).toBe(
      'Batch 0901-OLD has no returned or checked-out hangers in the selected range.'
    )
  })
  it('no selection: the generic message', () => {
    expect(emptyReportMessage(sel)).toBe('No hangers were returned or checked out in this range.')
  })
})
