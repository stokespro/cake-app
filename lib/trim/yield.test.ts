import { describe, expect, it } from 'vitest'
import {
  computeYield,
  emptyYieldTotals,
  mergeYieldTotals,
  summarizeYield,
  type YieldEpisodeInput,
  type YieldLoadInput,
} from './yield'

let seq = 0
function load(over: Partial<YieldLoadInput> = {}): YieldLoadInput {
  return {
    id: `L${++seq}`,
    batchId: 'B1',
    status: 'reconciled',
    plantCount: 10,
    wetG: 4000,
    dryG: 1000,
    remainingG: null,
    remainingPlantCount: null,
    ...over,
  }
}
function ep(loadId: string, over: Partial<YieldEpisodeInput> = {}): YieldEpisodeInput {
  return {
    loadId,
    status: 'returned',
    flowerG: 700,
    trimG: 200,
    stemsG: 80,
    processedG: 1000,
    plantsFinished: 10,
    ...over,
  }
}

describe('a fully trimmed batch', () => {
  const l1 = load()
  const l2 = load({ plantCount: 5, wetG: 2000, dryG: 500 })
  const { total } = computeYield(
    [l1, l2],
    [ep(l1.id), ep(l2.id, { flowerG: 350, trimG: 100, stemsG: 40, processedG: 500, plantsFinished: 5 })]
  )
  const s = summarizeYield(total)

  it('counts and sums', () => {
    expect(s.hangers).toBe(2)
    expect(s.plants.value).toBe(15)
    expect(s.wetG.value).toBe(6000)
    expect(s.dryG.value).toBe(1500)
    expect(s.flowerG.value).toBe(1050)
    expect(s.trimG.value).toBe(300)
    expect(s.stemsG.value).toBe(120)
    expect(s.processedG.value).toBe(1500)
  })

  it('computes each ratio', () => {
    expect(s.dryDownPct.value).toBe(25)
    expect(s.flowerPctOfProcessed.value).toBe(70)
    expect(s.trimPctOfProcessed.value).toBe(20)
    expect(s.stemsPctOfProcessed.value).toBe(8)
    expect(s.unaccountedPctOfProcessed.value).toBe(2)
    expect(s.wetToFlowerPct.value).toBe(17.5)
    expect(s.flowerPerPlantG.value).toBe(70)
  })

  it('reports full coverage', () => {
    expect(s.flowerPctOfProcessed.coverage).toEqual({ included: 2, total: 2, label: '2 of 2 hangers' })
    expect(s.remainingOnRacks).toEqual({ loads: 0, g: 0, plants: 0 })
  })
})

describe('partial population: each ratio over its own loads', () => {
  // 5 hangers: 2 reconciled, 1 mid-trim (dried only), 1 late entry (no wet, no plants), 1 hung (no dry).
  const a = load({ id: 'a' })
  const b = load({ id: 'b' })
  const c = load({ id: 'c', status: 'dried', wetG: 4000, dryG: 1000 })
  const d = load({ id: 'd', status: 'reconciled', wetG: null, plantCount: null })
  const e = load({ id: 'e', status: 'hung', dryG: null })
  const { total } = computeYield(
    [a, b, c, d, e],
    [ep('a'), ep('b'), ep('d', { plantsFinished: null })]
  )
  const s = summarizeYield(total)

  it('hangers is every non-void load', () => {
    expect(s.hangers).toBe(5)
  })

  it('dry-down uses loads with both wet and dry: a, b, c', () => {
    expect(s.dryDownPct.coverage).toEqual({ included: 3, total: 5, label: '3 of 5 hangers' })
    expect(s.dryDownPct.value).toBe(25)
  })

  it('flower % of processed includes the late-entry load (it has a return)', () => {
    expect(s.flowerPctOfProcessed.coverage.included).toBe(3)
    expect(s.flowerG.value).toBe(2100)
    expect(s.flowerPctOfProcessed.value).toBe(70)
  })

  it('wet-to-flower drops the late-entry load, which has no wet', () => {
    expect(s.wetToFlowerPct.coverage.included).toBe(2)
    expect(s.wetToFlowerPct.value).toBe(17.5)
  })

  it('flower per plant drops the load whose plants_finished is unknown', () => {
    expect(s.flowerPerPlantG.coverage.included).toBe(2)
    expect(s.flowerPerPlantG.value).toBe(70)
  })

  it('plants coverage counts only loads with a plant count', () => {
    expect(s.plants.coverage).toMatchObject({ included: 4, total: 5 })
    expect(s.plants.value).toBe(40)
  })

  it('wet sum covers the 4 loads with wet; dry covers the 4 with dry', () => {
    expect(s.wetG.coverage.included).toBe(4)
    expect(s.dryG.coverage.included).toBe(4)
  })

  it('a half-trimmed batch is not diluted by untrimmed hangers', () => {
    // 3 of 5 hangers returned; flower % must still be 70%, not 42%.
    expect(s.flowerPctOfProcessed.value).toBe(70)
  })
})

describe('partial returns (R2.2)', () => {
  it('an unfinished episode counts toward processed ratios immediately', () => {
    const l = load({ status: 'partial', remainingG: 600, remainingPlantCount: 6, dryG: 1000 })
    const { total } = computeYield(
      [l],
      [ep(l.id, { flowerG: 280, trimG: 80, stemsG: 36, processedG: 400, plantsFinished: 4 })]
    )
    const s = summarizeYield(total)
    expect(s.flowerPctOfProcessed.value).toBe(70)
    expect(s.processedG.value).toBe(400)
    expect(s.remainingOnRacks).toEqual({ loads: 1, g: 600, plants: 6 })
  })

  it('but a partial load is excluded from whole-load ratios until reconciled', () => {
    const l = load({ status: 'partial', remainingG: 600, remainingPlantCount: 6 })
    const s = summarizeYield(computeYield([l], [ep(l.id, { processedG: 400, plantsFinished: 4 })]).total)
    expect(s.wetToFlowerPct.value).toBeNull()
    expect(s.wetToFlowerPct.coverage.included).toBe(0)
    expect(s.flowerPerPlantG.value).toBeNull()
  })

  it('two episodes on one load add up, and plants_finished sums to the plant count', () => {
    const l = load({ plantCount: 10 })
    const { total } = computeYield(
      [l],
      [
        ep(l.id, { flowerG: 280, trimG: 80, stemsG: 40, processedG: 400, plantsFinished: 4 }),
        ep(l.id, { flowerG: 420, trimG: 120, stemsG: 60, processedG: 600, plantsFinished: 6 }),
      ]
    )
    const s = summarizeYield(total)
    expect(s.hangers).toBe(1)
    expect(s.flowerG.value).toBe(700)
    expect(s.processedG.value).toBe(1000)
    expect(s.flowerPerPlantG.value).toBe(70)
    expect(s.wetToFlowerPct.value).toBe(17.5)
    // one load, however many episodes
    expect(s.flowerPctOfProcessed.coverage).toMatchObject({ included: 1, total: 1 })
  })

  it('an episode with zero plants finished still counts in the load total', () => {
    const l = load({ plantCount: 10 })
    const s = summarizeYield(
      computeYield(
        [l],
        [
          ep(l.id, { flowerG: 100, trimG: 30, stemsG: 10, processedG: 150, plantsFinished: 0 }),
          ep(l.id, { flowerG: 600, trimG: 170, stemsG: 70, processedG: 850, plantsFinished: 10 }),
        ]
      ).total
    )
    expect(s.flowerPerPlantG.value).toBe(70)
  })

  it('remaining on racks sums across partial loads and tolerates nulls', () => {
    const a = load({ status: 'partial', remainingG: 600.5, remainingPlantCount: 6 })
    const b = load({ status: 'partial', remainingG: 1200.25, remainingPlantCount: 3 })
    const c = load({ status: 'partial', remainingG: null, remainingPlantCount: null })
    const s = summarizeYield(computeYield([a, b, c], []).total)
    expect(s.remainingOnRacks).toEqual({ loads: 3, g: 1800.75, plants: 9 })
  })

  it('a flagged (returned) load feeds processed ratios but not whole-load ratios', () => {
    const l = load({ status: 'returned' })
    const s = summarizeYield(computeYield([l], [ep(l.id)]).total)
    expect(s.flowerPctOfProcessed.value).toBe(70)
    expect(s.wetToFlowerPct.value).toBeNull()
  })
})

describe('void loads are excluded', () => {
  it('from counts, sums and ratios', () => {
    const good = load()
    const voided = load({ status: 'void', wetG: 99999, dryG: 99999 })
    const s = summarizeYield(computeYield([good, voided], [ep(good.id)]).total)
    expect(s.hangers).toBe(1)
    expect(s.wetG.value).toBe(4000)
    expect(s.dryDownPct.value).toBe(25)
  })

  it('including the returned episodes of a voided partial load (R2.12)', () => {
    const good = load()
    const voided = load({ status: 'void' })
    const s = summarizeYield(
      computeYield([good, voided], [ep(good.id), ep(voided.id, { flowerG: 9999, processedG: 20000 })]).total
    )
    expect(s.flowerG.value).toBe(700)
    expect(s.processedG.value).toBe(1000)
  })

  it('a void load does not count as a rack either', () => {
    const v = load({ status: 'void', remainingG: 500, remainingPlantCount: 5 })
    expect(summarizeYield(computeYield([v], []).total).remainingOnRacks.loads).toBe(0)
  })
})

describe('episode filtering', () => {
  it('ignores out and released episodes', () => {
    const l = load()
    const s = summarizeYield(
      computeYield(
        [l],
        [
          ep(l.id, { status: 'out', flowerG: null, trimG: null, stemsG: null, processedG: null }),
          ep(l.id, { status: 'released', flowerG: 5000 }),
          ep(l.id),
        ]
      ).total
    )
    expect(s.flowerG.value).toBe(700)
  })

  it('ignores returned episodes with missing weights or a zero denominator', () => {
    const l = load()
    const s = summarizeYield(
      computeYield(
        [l],
        [ep(l.id, { flowerG: null }), ep(l.id, { processedG: 0 }), ep(l.id, { trimG: -1 }), ep(l.id)]
      ).total
    )
    expect(s.flowerG.value).toBe(700)
  })

  it('ignores episodes whose load is not in the list', () => {
    const l = load()
    const s = summarizeYield(computeYield([l], [ep('ghost')]).total)
    expect(s.flowerG.value).toBeNull()
    expect(s.flowerG.coverage.included).toBe(0)
  })
})

describe('zero denominators and empty input', () => {
  it('no loads: everything is null, nothing divides by zero', () => {
    const s = summarizeYield(computeYield([], []).total)
    expect(s.hangers).toBe(0)
    for (const m of [
      s.plants, s.wetG, s.dryG, s.flowerG, s.processedG, s.dryDownPct, s.flowerPctOfProcessed,
      s.unaccountedPctOfProcessed, s.wetToFlowerPct, s.flowerPerPlantG,
    ]) {
      expect(m.value).toBeNull()
    }
    expect(s.flowerG.coverage.label).toBe('0 of 0 hangers')
  })

  it('emptyYieldTotals summarizes the same as no input', () => {
    expect(summarizeYield(emptyYieldTotals())).toEqual(summarizeYield(computeYield([], []).total))
  })

  it('zero wet weight cannot produce Infinity', () => {
    const l = load({ wetG: 0 })
    const s = summarizeYield(computeYield([l], [ep(l.id)]).total)
    expect(s.dryDownPct.value).toBeNull()
    expect(s.wetToFlowerPct.value).toBeNull()
  })

  it('returns with no flower at all are a real 0%, not null', () => {
    const l = load()
    const s = summarizeYield(
      computeYield([l], [ep(l.id, { flowerG: 0, trimG: 900, stemsG: 100, processedG: 1000 })]).total
    )
    expect(s.flowerPctOfProcessed.value).toBe(0)
  })

  it('unaccounted is negative when more came back than was processed', () => {
    const l = load()
    const s = summarizeYield(
      computeYield([l], [ep(l.id, { flowerG: 800, trimG: 200, stemsG: 100, processedG: 1000 })]).total
    )
    expect(s.unaccountedPctOfProcessed.value).toBe(-10)
  })

  it('singular label', () => {
    const l = load()
    expect(summarizeYield(computeYield([l], [ep(l.id)]).total).flowerG.coverage.label).toBe('1 of 1 hanger')
  })
})

describe('cycle roll-up equals the sum of its batches', () => {
  const loads = [
    load({ id: 'x1', batchId: 'B1' }),
    load({ id: 'x2', batchId: 'B1', wetG: 3333.33, dryG: 777.77, plantCount: 7 }),
    load({ id: 'x3', batchId: 'B2', wetG: null, plantCount: null }),
    load({ id: 'x4', batchId: 'B2', status: 'partial', remainingG: 123.45, remainingPlantCount: 2 }),
    load({ id: 'x5', batchId: 'B3', status: 'dried', dryG: 1111.11 }),
    load({ id: 'x6', batchId: 'B3', status: 'void' }),
  ]
  const episodes = [
    ep('x1'),
    ep('x2', { flowerG: 543.21, trimG: 111.11, stemsG: 22.22, processedG: 700, plantsFinished: 7 }),
    ep('x3', { plantsFinished: null }),
    ep('x4', { flowerG: 12.34, trimG: 5.67, stemsG: 1.01, processedG: 20, plantsFinished: 3 }),
    ep('x6'),
  ]

  it('merging per-batch totals gives exactly the directly computed cycle totals', () => {
    const cycle = computeYield(loads, episodes)
    const perBatch = ['B1', 'B2', 'B3'].map(
      (id) =>
        computeYield(
          loads.filter((l) => l.batchId === id),
          episodes
        ).total
    )
    expect(mergeYieldTotals(...perBatch)).toEqual(cycle.total)
    expect(mergeYieldTotals(...perBatch.reverse())).toEqual(cycle.total)
  })

  it('byBatch splits by batch id and sums back to the total', () => {
    const cycle = computeYield(loads, episodes)
    expect([...cycle.byBatch.keys()].sort()).toEqual(['B1', 'B2', 'B3'])
    expect(mergeYieldTotals(...cycle.byBatch.values())).toEqual(cycle.total)
    expect(cycle.byBatch.get('B3')?.hangers).toBe(1) // void excluded
  })

  it('the summarized figures agree too', () => {
    const cycle = computeYield(loads, episodes)
    const merged = mergeYieldTotals(...cycle.byBatch.values())
    expect(summarizeYield(merged)).toEqual(summarizeYield(cycle.total))
  })

  it('merge does not mutate its inputs', () => {
    const a = computeYield([loads[0]], [episodes[0]]).total
    const snapshot = JSON.stringify(a)
    mergeYieldTotals(a, a)
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  it('grams survive hundredths accumulation without float drift', () => {
    const many = Array.from({ length: 300 }, (_, i) => load({ id: `m${i}`, wetG: 1000.01, dryG: 250.01 }))
    const s = summarizeYield(computeYield(many, []).total)
    expect(s.wetG.value).toBe(300003)
    expect(s.dryG.value).toBe(75003)
  })
})
