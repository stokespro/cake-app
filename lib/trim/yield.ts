// Yield formulas for batches, strains and cycles (plan section 6, as revised by R2.8).
//
// Two rules keep a half-trimmed batch from reporting a falsely low yield:
//
//   1. Every ratio is computed ONLY over the loads that have both its numerator
//      and its denominator, and every figure reports that coverage
//      ("41 of 58 hangers"). A late-entry load with no wet weight simply drops
//      out of the wet-based ratios; it is not counted as zero.
//   2. The population differs by what the denominator means:
//        - ratios over processed_g (flower/trim/stems/unaccounted %) work at
//          EPISODE level over every returned episode, so a partial return's
//          work counts the moment it is weighed;
//        - ratios over a WHOLE-load figure (dry-down needs wet+dry; wet-to-
//          flower needs wet; flower-per-plant needs plants) use only loads
//          with the right inputs, and the two that depend on the load's final
//          flower (wet-to-flower, flower-per-plant) additionally wait for
//          status 'reconciled' — flower so far against a full wet weight would
//          read falsely low.
//   Void loads are excluded everywhere, including their returned episodes
//   (a partial load can be voided by an admin, R2.12).
//
// `remaining on racks` is the grams/plants still on the hangers of loads in
// status 'partial'. There is no written-off figure: R2.12 dropped write-offs.
//
// Everything is accumulated as integer hundredths of a gram, so a cycle
// roll-up (mergeYieldTotals over the batches) is EXACTLY the figure you would
// get by computing the cycle directly, in any merge order.
//
// Performance: one pass over episodes to group them by load, one pass over
// loads. No sorting, no nested scans.
//
// Pure: no imports from actions/, no I/O.

import { roundTo } from '@/lib/units'
import type { CheckoutStatus, HangerLoadStatus } from '@/types/harvest-trim'

export interface YieldLoadInput {
  id: string
  batchId: string
  status: HangerLoadStatus
  plantCount: number | null
  wetG: number | null
  dryG: number | null
  /** Cached remaining weight on the hanger (hanger_loads.remaining_g). */
  remainingG: number | null
  remainingPlantCount: number | null
}

export interface YieldEpisodeInput {
  loadId: string
  /** Only 'returned' episodes count. */
  status: CheckoutStatus
  flowerG: number | null
  trimG: number | null
  stemsG: number | null
  /** trim_checkouts.processed_g (issued - remaining). */
  processedG: number | null
  /** trim_checkouts.plants_finished. */
  plantsFinished: number | null
}

/**
 * Additive building blocks. Weights are INTEGER HUNDREDTHS of a gram (suffix H)
 * so merging is exact. Each `*Loads` field is the coverage numerator of the
 * metric next to it.
 */
export interface YieldTotals {
  /** Non-void loads. The coverage denominator for everything. */
  hangers: number

  plantLoads: number
  plants: number

  wetLoads: number
  wetH: number

  dryLoads: number
  dryH: number

  /** Loads with both wet and dry. */
  dryWetLoads: number
  dryWetDryH: number
  dryWetWetH: number

  /** Loads with at least one valid returned episode, and the episode-level sums. */
  returnLoads: number
  flowerH: number
  trimH: number
  stemsH: number
  processedH: number

  /** Reconciled loads with wet and a return. */
  wetFlowerLoads: number
  wetFlowerWetH: number
  wetFlowerFlowerH: number

  /** Reconciled loads whose every returned episode knows plants_finished. */
  perPlantLoads: number
  perPlantFlowerH: number
  perPlantPlants: number

  /** Loads currently 'partial': plants still on the racks. */
  rackLoads: number
  rackH: number
  rackPlants: number
}

export function emptyYieldTotals(): YieldTotals {
  return {
    hangers: 0,
    plantLoads: 0,
    plants: 0,
    wetLoads: 0,
    wetH: 0,
    dryLoads: 0,
    dryH: 0,
    dryWetLoads: 0,
    dryWetDryH: 0,
    dryWetWetH: 0,
    returnLoads: 0,
    flowerH: 0,
    trimH: 0,
    stemsH: 0,
    processedH: 0,
    wetFlowerLoads: 0,
    wetFlowerWetH: 0,
    wetFlowerFlowerH: 0,
    perPlantLoads: 0,
    perPlantFlowerH: 0,
    perPlantPlants: 0,
    rackLoads: 0,
    rackH: 0,
    rackPlants: 0,
  }
}

/** Sum any number of totals into a new object. Exact and order-independent. */
export function mergeYieldTotals(...parts: readonly YieldTotals[]): YieldTotals {
  const out = emptyYieldTotals()
  const keys = Object.keys(out) as Array<keyof YieldTotals>
  for (const part of parts) {
    for (const k of keys) out[k] += part[k]
  }
  return out
}

function h(g: number): number {
  return Math.round(g * 100)
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function isValidEpisode(e: YieldEpisodeInput): boolean {
  return (
    e.status === 'returned' &&
    isNum(e.flowerG) &&
    e.flowerG >= 0 &&
    isNum(e.trimG) &&
    e.trimG >= 0 &&
    isNum(e.stemsG) &&
    e.stemsG >= 0 &&
    isNum(e.processedG) &&
    e.processedG > 0
  )
}

function addLoad(t: YieldTotals, load: YieldLoadInput, episodes: readonly YieldEpisodeInput[] | undefined) {
  t.hangers++

  if (isNum(load.plantCount)) {
    t.plantLoads++
    t.plants += load.plantCount
  }
  const hasWet = isNum(load.wetG)
  const hasDry = isNum(load.dryG)
  if (hasWet) {
    t.wetLoads++
    t.wetH += h(load.wetG as number)
  }
  if (hasDry) {
    t.dryLoads++
    t.dryH += h(load.dryG as number)
  }
  if (hasWet && hasDry) {
    t.dryWetLoads++
    t.dryWetDryH += h(load.dryG as number)
    t.dryWetWetH += h(load.wetG as number)
  }

  if (load.status === 'partial') {
    t.rackLoads++
    t.rackH += isNum(load.remainingG) ? h(load.remainingG) : 0
    t.rackPlants += isNum(load.remainingPlantCount) ? load.remainingPlantCount : 0
  }

  // Episode level.
  let valid = 0
  let flowerH = 0
  let plantsKnown = true
  let plantsFinished = 0
  if (episodes) {
    for (const e of episodes) {
      if (!isValidEpisode(e)) continue
      valid++
      const f = h(e.flowerG as number)
      flowerH += f
      t.flowerH += f
      t.trimH += h(e.trimG as number)
      t.stemsH += h(e.stemsG as number)
      t.processedH += h(e.processedG as number)
      if (isNum(e.plantsFinished) && e.plantsFinished >= 0) plantsFinished += e.plantsFinished
      else plantsKnown = false
    }
  }
  if (valid > 0) {
    t.returnLoads++
    // Whole-load ratios wait for the load to be finished.
    if (load.status === 'reconciled') {
      if (hasWet) {
        t.wetFlowerLoads++
        t.wetFlowerWetH += h(load.wetG as number)
        t.wetFlowerFlowerH += flowerH
      }
      if (plantsKnown && plantsFinished > 0) {
        t.perPlantLoads++
        t.perPlantFlowerH += flowerH
        t.perPlantPlants += plantsFinished
      }
    }
  }
}

export interface YieldComputation {
  /** Everything passed in (non-void), i.e. the cycle or strain roll-up. */
  total: YieldTotals
  /** The same figures per batch id. */
  byBatch: Map<string, YieldTotals>
}

/**
 * One pass over episodes, one over loads. Episodes whose load isn't in `loads`
 * (or is void) are ignored. Pass the loads and episodes for one batch, or for a
 * whole cycle/strain — `byBatch` always splits by load.batchId.
 */
export function computeYield(
  loads: readonly YieldLoadInput[],
  episodes: readonly YieldEpisodeInput[]
): YieldComputation {
  const byLoad = new Map<string, YieldEpisodeInput[]>()
  for (const e of episodes) {
    if (e.status !== 'returned') continue
    const list = byLoad.get(e.loadId)
    if (list) list.push(e)
    else byLoad.set(e.loadId, [e])
  }

  const byBatch = new Map<string, YieldTotals>()
  for (const load of loads) {
    if (load.status === 'void') continue
    let t = byBatch.get(load.batchId)
    if (!t) {
      t = emptyYieldTotals()
      byBatch.set(load.batchId, t)
    }
    addLoad(t, load, byLoad.get(load.id))
  }
  return { total: mergeYieldTotals(...byBatch.values()), byBatch }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface YieldCoverage {
  included: number
  total: number
  /** "41 of 58 hangers" */
  label: string
}

export interface YieldMetric {
  /** null = no data (nothing included, or a zero denominator). */
  value: number | null
  coverage: YieldCoverage
}

export interface YieldSummary {
  hangers: number
  plants: YieldMetric
  wetG: YieldMetric
  dryG: YieldMetric
  flowerG: YieldMetric
  trimG: YieldMetric
  stemsG: YieldMetric
  /** Grams actually worked: issued minus what stayed on the hanger. */
  processedG: YieldMetric
  /** dry / wet, over loads with both. */
  dryDownPct: YieldMetric
  /** flower / processed_g over every returned episode. */
  flowerPctOfProcessed: YieldMetric
  trimPctOfProcessed: YieldMetric
  stemsPctOfProcessed: YieldMetric
  /** (processed - flower - trim - stems) / processed. Positive = loss. */
  unaccountedPctOfProcessed: YieldMetric
  /** flower / wet, over reconciled loads with wet. */
  wetToFlowerPct: YieldMetric
  /** flower / plants_finished, over reconciled loads. */
  flowerPerPlantG: YieldMetric
  remainingOnRacks: { loads: number; g: number; plants: number }
}

function coverage(included: number, total: number): YieldCoverage {
  return { included, total, label: `${included} of ${total} ${total === 1 ? 'hanger' : 'hangers'}` }
}

function sum(included: number, total: number, value: number): YieldMetric {
  return { value: included > 0 ? value : null, coverage: coverage(included, total) }
}

function ratio(included: number, total: number, num: number, den: number, scale: number, dp: number): YieldMetric {
  return {
    value: included > 0 && den > 0 ? roundTo((num / den) * scale, dp) : null,
    coverage: coverage(included, total),
  }
}

/** Turn additive totals into the figures the report shows. */
export function summarizeYield(t: YieldTotals): YieldSummary {
  const n = t.hangers
  const unaccountedH = t.processedH - t.flowerH - t.trimH - t.stemsH
  return {
    hangers: n,
    plants: sum(t.plantLoads, n, t.plants),
    wetG: sum(t.wetLoads, n, t.wetH / 100),
    dryG: sum(t.dryLoads, n, t.dryH / 100),
    flowerG: sum(t.returnLoads, n, t.flowerH / 100),
    trimG: sum(t.returnLoads, n, t.trimH / 100),
    stemsG: sum(t.returnLoads, n, t.stemsH / 100),
    processedG: sum(t.returnLoads, n, t.processedH / 100),
    dryDownPct: ratio(t.dryWetLoads, n, t.dryWetDryH, t.dryWetWetH, 100, 2),
    flowerPctOfProcessed: ratio(t.returnLoads, n, t.flowerH, t.processedH, 100, 2),
    trimPctOfProcessed: ratio(t.returnLoads, n, t.trimH, t.processedH, 100, 2),
    stemsPctOfProcessed: ratio(t.returnLoads, n, t.stemsH, t.processedH, 100, 2),
    unaccountedPctOfProcessed: ratio(t.returnLoads, n, unaccountedH, t.processedH, 100, 2),
    wetToFlowerPct: ratio(t.wetFlowerLoads, n, t.wetFlowerFlowerH, t.wetFlowerWetH, 100, 2),
    // flower is in hundredths of a gram, so /100 turns it back into grams per plant.
    flowerPerPlantG: ratio(t.perPlantLoads, n, t.perPlantFlowerH, t.perPlantPlants, 0.01, 2),
    remainingOnRacks: { loads: t.rackLoads, g: t.rackH / 100, plants: t.rackPlants },
  }
}
