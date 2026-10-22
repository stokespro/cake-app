// Harvest & Trim reports: ordering and rollups for the per-hanger table.
//
// Everything here works on the FULL list of episodes the action returned, never on whatever happens to be on
// screen. Sorting, the per-trimmer subtotals and the totals cards are all computed over the whole filtered
// result set; the component may render only a slice of the rows (limitDisplayItems), but a subtotal is
// built before that slice is taken and a block is never cut in front of its subtotal.
//
// Variance: the action returns the database sign (loss positive); the screens flip it (negative = weight
// missing). The Variance column sorts by MAGNITUDE of the variance percentage, so "descending" reads as
// "furthest from balanced first" whether the hanger lost weight or gained it, which is the anomaly-triage
// order (a -29.86% hanger tops the list). Grams break ties and cover rows with no percentage.
//
// Pure: no React, no I/O.

import type { TrimDayEpisode } from '@/actions/trim-reports'
import { roundTo } from '@/lib/units'
import { sumMoney } from './pay'
import type { ReportColumnKey } from './report-columns'

export type SortKey = ReportColumnKey
export type SortDirection = 'asc' | 'desc'
export interface SortState {
  key: SortKey
  dir: SortDirection
}

/** Sort order of the status pill: the ones needing attention first when ascending. */
const STATUS_RANK: Record<string, number> = { flagged: 0, accepted: 1, ok: 2 }

type SortValue = number | string | null

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' })

function time(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function abs(n: number | null): number | null {
  return n === null ? null : Math.abs(n)
}

/** The value a column sorts on. null = no value: it sorts last in both directions. */
export function sortValue(e: TrimDayEpisode, key: SortKey): SortValue {
  switch (key) {
    case 'hanger':
      return e.hangerCode || null
    case 'batch':
      return e.batchName
    case 'trimmer':
      return e.trimmerName || null
    case 'outIn':
      return time(e.checkedOutAt)
    case 'issued':
      return e.issuedG
    case 'flower':
      return e.flowerG
    case 'trim':
      return e.trimG
    case 'stems':
      return e.stemsG
    case 'variance':
      return abs(e.variancePct) ?? abs(e.varianceG)
    case 'status':
      return e.varianceStatus === null ? null : (STATUS_RANK[e.varianceStatus] ?? null)
    case 'pay':
      return e.payAmount
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b)
  return (a as number) - (b as number)
}

/** Chronological, then episode number, then id: the order every sort falls back on so ties are stable. */
function byCheckout(a: TrimDayEpisode, b: TrimDayEpisode): number {
  const ta = time(a.checkedOutAt)
  const tb = time(b.checkedOutAt)
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  }
  return a.seq - b.seq || (a.checkoutId < b.checkoutId ? -1 : a.checkoutId > b.checkoutId ? 1 : 0)
}

/**
 * Comparator for a column and direction. Missing values (null) sort LAST in both directions: the
 * direction only ever flips the order of real values. Ties fall back to checkout time (ascending, whatever
 * the direction), so a sort by Trimmer reads as each person's day in order.
 */
export function compareEpisodes(sort: SortState): (a: TrimDayEpisode, b: TrimDayEpisode) => number {
  const sign = sort.dir === 'asc' ? 1 : -1
  return (a, b) => {
    const va = sortValue(a, sort.key)
    const vb = sortValue(b, sort.key)
    if (va === null && vb !== null) return 1
    if (vb === null && va !== null) return -1
    if (va !== null && vb !== null) {
      const c = compareValues(va, vb)
      if (c !== 0) return c * sign
    }
    // Same trimmer name but two different people must not interleave (subtotal blocks are contiguous).
    if (sort.key === 'trimmer' && a.trimmerId !== b.trimmerId) return (a.trimmerId < b.trimmerId ? -1 : 1) * sign
    return byCheckout(a, b)
  }
}

export function sortEpisodes(episodes: readonly TrimDayEpisode[], sort: SortState): TrimDayEpisode[] {
  return [...episodes].sort(compareEpisodes(sort))
}

/**
 * The order the page opens in. One trimmer selected: chronological, the right read of one person's day.
 * Everyone: by trimmer (then checkout time), so a crew day clusters by person instead of interleaving.
 */
export function defaultSort(trimmerSelected: boolean): SortState {
  return trimmerSelected ? { key: 'outIn', dir: 'asc' } : { key: 'trimmer', dir: 'asc' }
}

/** A click the user made, remembered with the filters it was made under. */
export interface UserSort extends SortState {
  /** Identifies the filter set (range, batch, trimmer). A click made under other filters no longer applies. */
  filterSig: string
}

/**
 * The sort to apply: the user's own click if it was made under the filters now in effect, else the
 * default. An explicit click wins and sticks until the filters change.
 */
export function resolveSort(userSort: UserSort | null, filterSig: string, trimmerSelected: boolean): SortState {
  if (userSort && userSort.filterSig === filterSig) return { key: userSort.key, dir: userSort.dir }
  return defaultSort(trimmerSelected)
}

/** What a header click does: the same column flips direction, a different column starts ascending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: 'asc' }
}

// ─── Subtotals ───────────────────────────────────────────────────────────────

export interface TrimmerSubtotal {
  trimmerId: string
  trimmerName: string
  /** Distinct hangers (loads): a hanger returned twice counts once, the same rule as the totals cards. */
  hangers: number
  /** Returned episodes in the block. */
  episodes: number
  issuedG: number
  flowerG: number
  /** Database sign (loss positive); the screen flips it. */
  varianceG: number
  /** Null when the viewer has no pay access or no episode in the block has a pay line. */
  payAmount: number | null
}

/** Sum a block of episodes. Grams are rounded like the action's totals; money is summed in cents. */
export function subtotalOf(block: readonly TrimDayEpisode[]): TrimmerSubtotal {
  let issued = 0
  let flower = 0
  let variance = 0
  const loads = new Set<string>()
  const amounts: number[] = []
  for (const e of block) {
    loads.add(e.loadId)
    issued += e.issuedG ?? 0
    flower += e.flowerG ?? 0
    variance += e.varianceG ?? 0
    if (e.payAmount !== null) amounts.push(e.payAmount)
  }
  return {
    trimmerId: block[0]?.trimmerId ?? '',
    trimmerName: block[0]?.trimmerName ?? '',
    hangers: loads.size,
    episodes: block.length,
    issuedG: roundTo(issued, 2),
    flowerG: roundTo(flower, 2),
    varianceG: roundTo(variance, 2),
    payAmount: amounts.length > 0 ? sumMoney(amounts) : null,
  }
}

export type DisplayItem =
  | { kind: 'episode'; episode: TrimDayEpisode }
  | { kind: 'subtotal'; subtotal: TrimmerSubtotal }

/**
 * The table's rows in order. With `withSubtotals` (only meaningful when the list is sorted by trimmer, so
 * each person's rows are contiguous) a subtotal item follows each consecutive run of one trimmer.
 */
export function buildDisplayItems(sorted: readonly TrimDayEpisode[], withSubtotals: boolean): DisplayItem[] {
  const items: DisplayItem[] = []
  let block: TrimDayEpisode[] = []
  const flush = () => {
    if (withSubtotals && block.length > 0) items.push({ kind: 'subtotal', subtotal: subtotalOf(block) })
    block = []
  }
  for (const e of sorted) {
    if (block.length > 0 && block[0].trimmerId !== e.trimmerId) flush()
    block.push(e)
    items.push({ kind: 'episode', episode: e })
  }
  flush()
  return items
}

/** Subtotals show only when the table is sorted by trimmer: in any other order they are meaningless. */
export function showsSubtotals(sort: SortState): boolean {
  return sort.key === 'trimmer'
}

/**
 * Cut the rows to render down to about `maxEpisodes` hangers. When subtotals are present the cut is moved
 * to the end of the trimmer block it falls in, so a block is never shown half-finished next to a subtotal
 * that covers all of it. Returns the slice and how many hangers (episode rows) it holds.
 */
export function limitDisplayItems(
  items: readonly DisplayItem[],
  maxEpisodes: number
): { items: DisplayItem[]; shownEpisodes: number } {
  const hasSubtotals = items.some((i) => i.kind === 'subtotal')
  const out: DisplayItem[] = []
  let shown = 0
  for (const item of items) {
    if (item.kind === 'episode') {
      if (shown >= maxEpisodes && !hasSubtotals) break
      shown++
      out.push(item)
    } else {
      out.push(item)
      if (shown >= maxEpisodes) break
    }
  }
  return { items: out, shownEpisodes: shown }
}
