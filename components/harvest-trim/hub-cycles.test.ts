import { describe, expect, it } from 'vitest'
import { ALL_CYCLES, hubCycles, pickHubCycle } from './hub-cycles'

const c = (id: string, stage: string) => ({ id, stage })

describe('hubCycles', () => {
  it('keeps only harvest, dry and trim cycles', () => {
    const out = hubCycles([
      c('f1', 'flower'),
      c('h', 'harvest'),
      c('d', 'dry'),
      c('t', 'trim'),
      c('dome', 'dome'),
      c('veg', 'veg'),
    ])
    expect(out.map((x) => x.id)).toEqual(['h', 'd', 't'])
  })

  it('drops the flower cycles that are still ahead of harvest', () => {
    expect(hubCycles([c('f1', 'flower'), c('f2', 'flower'), c('t', 'trim')]).map((x) => x.id)).toEqual(['t'])
  })

  it('preserves input order and returns an empty list when nothing qualifies', () => {
    expect(hubCycles([c('d', 'dry'), c('t', 'trim')]).map((x) => x.id)).toEqual(['d', 't'])
    expect(hubCycles([c('f1', 'flower'), c('v', 'veg')])).toEqual([])
    expect(hubCycles([])).toEqual([])
  })
})

describe('pickHubCycle', () => {
  const visible = [c('d', 'dry'), c('t', 'trim')]

  it('keeps a remembered cycle that is still visible', () => {
    expect(pickHubCycle(visible, 'd')).toBe('d')
  })

  it('keeps a remembered "all"', () => {
    expect(pickHubCycle(visible, ALL_CYCLES)).toBe(ALL_CYCLES)
    expect(pickHubCycle([], ALL_CYCLES)).toBe(ALL_CYCLES)
  })

  it('falls back to the trim cycle when the remembered cycle is no longer visible (e.g. it was in flower)', () => {
    expect(pickHubCycle(visible, 'gone-flower-cycle')).toBe('t')
  })

  it('falls back to dry, then the first cycle, when there is no trim cycle', () => {
    expect(pickHubCycle([c('h', 'harvest'), c('d', 'dry')], 'gone')).toBe('d')
    expect(pickHubCycle([c('h', 'harvest')], 'gone')).toBe('h')
  })

  it('uses the same default when nothing is remembered', () => {
    expect(pickHubCycle(visible, null)).toBe('t')
  })

  it('falls back to "all" when no cycle is visible, even if a stale cycle is remembered', () => {
    expect(pickHubCycle([], 'gone')).toBe(ALL_CYCLES)
    expect(pickHubCycle([], null)).toBe(ALL_CYCLES)
  })

  it('never returns a value that is not on offer', () => {
    for (const stored of [null, 'x', ALL_CYCLES, 'd', 't']) {
      const pick = pickHubCycle(visible, stored)
      expect(pick === ALL_CYCLES || visible.some((v) => v.id === pick)).toBe(true)
    }
  })
})
