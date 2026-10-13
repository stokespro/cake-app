import { describe, expect, it } from 'vitest'
import type { CycleOption } from '@/actions/harvest-trim'
import { eligibleCycles, harvestReached, nextHarvest, pickCycleId, todayLocal } from './harvest-cycles'

function cycle(id: string, harvestDate: string | null, stage = 'flower', batchCount = 0): CycleOption {
  return {
    id,
    cycleNumber: 1,
    stage,
    harvestDate,
    dryStart: null,
    trimStart: null,
    roomId: null,
    roomName: null,
    roomNumber: 1,
    batchCount,
  }
}

const TODAY = '2026-10-13'

describe('harvestReached', () => {
  it('is true on the harvest date and after it', () => {
    expect(harvestReached(cycle('a', '2026-10-13'), TODAY)).toBe(true)
    expect(harvestReached(cycle('a', '2026-10-01'), TODAY)).toBe(true)
  })
  it('is false for a date still ahead', () => {
    expect(harvestReached(cycle('a', '2026-10-14'), TODAY)).toBe(false)
  })
  it('is false when the cycle has no harvest date', () => {
    expect(harvestReached(cycle('a', null), TODAY)).toBe(false)
  })
  it('tolerates a timestamp-shaped date', () => {
    expect(harvestReached(cycle('a', '2026-10-13T00:00:00+00:00'), TODAY)).toBe(true)
  })
})

describe('eligibleCycles', () => {
  it('drops cycles that have not hit their harvest date, whether or not they have batches', () => {
    const out = eligibleCycles([cycle('future', '2026-10-29', 'flower', 3), cycle('now', '2026-10-13')], TODAY)
    expect(out.map((c) => c.id)).toEqual(['now'])
  })
  it('keeps a reached cycle that has no batches (it goes to the declare step)', () => {
    expect(eligibleCycles([cycle('empty', '2026-10-12', 'harvest', 0)], TODAY)).toHaveLength(1)
  })
  it('puts rooms not yet dried first, then the most recent harvest', () => {
    const out = eligibleCycles(
      [
        cycle('dry-recent', '2026-10-12', 'dry'),
        cycle('flower-old', '2026-10-01', 'flower'),
        cycle('harvest-new', '2026-10-13', 'harvest'),
      ],
      TODAY
    )
    expect(out.map((c) => c.id)).toEqual(['harvest-new', 'flower-old', 'dry-recent'])
  })
  it('does not mutate its input', () => {
    const input = [cycle('b', '2026-10-01'), cycle('a', '2026-10-13')]
    eligibleCycles(input, TODAY)
    expect(input.map((c) => c.id)).toEqual(['b', 'a'])
  })
})

describe('nextHarvest', () => {
  it('returns the soonest harvest still ahead', () => {
    const out = nextHarvest([cycle('late', '2026-11-20'), cycle('f5', '2026-10-29'), cycle('past', '2026-10-01')], TODAY)
    expect(out?.id).toBe('f5')
  })
  it('is null when nothing is ahead', () => {
    expect(nextHarvest([cycle('past', '2026-10-01'), cycle('none', null)], TODAY)).toBeNull()
  })
})

describe('pickCycleId', () => {
  const eligible = [cycle('a', '2026-10-13'), cycle('b', '2026-10-12')]
  it('keeps the remembered cycle while it is still eligible', () => {
    expect(pickCycleId(eligible, 'b')).toBe('b')
  })
  it('falls back to the first when the remembered cycle is gone', () => {
    expect(pickCycleId(eligible, 'zzz')).toBe('a')
    expect(pickCycleId(eligible, null)).toBe('a')
  })
  it('is null with nothing eligible', () => {
    expect(pickCycleId([], 'a')).toBeNull()
  })
})

describe('todayLocal', () => {
  it('formats the local calendar date', () => {
    expect(todayLocal(new Date(2026, 9, 13, 5, 30))).toBe('2026-10-13')
  })
})
