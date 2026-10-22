// Harvest & Trim reports: the Batch and Trimmer dropdown options, derived from the report's own rows.
//
// The two lists are NOT looked up separately. The action fetches every episode in the date range once,
// derives both lists from that same set, and only then narrows it for the table, so a list and the table can
// never disagree. The invariant this module keeps: no option offered with a count above zero can return
// zero rows, because the count IS the number of hangers that selecting it leaves on screen.
//
// The cascade is one-way, Date -> Batch -> Trimmer:
//   - batch options come from the date range alone (picking a trimmer never narrows them);
//   - trimmer options come from the date range AND the selected batch.
//
// Two counts per option. `hangers` is every hanger with assigned work in the range (returned or still out) and
// decides WHICH options exist, so the list never churns when the "Finished only" toggle flips. `returnedHangers`
// is the returned-only subset: it is the number shown while Finished only is on, and it is the same set of
// hangers the Hangers tile counts. The toggle picks which count is displayed (optionCount) and nothing else.
//
// A selection that has dropped out of its list (a trimmer who did not work the newly chosen day) is kept and
// shown with a zero count, never silently reset: widening what the viewer is looking at without saying so is
// the failure mode this avoids (withSelectedOption, emptyReportMessage).
//
// Pure: no React, no I/O. Imported by the action ('use server' files may import helpers, not export them).

import type { TrimBatchOption, TrimTrimmerOption } from '@/actions/trim-reports'

/** What the dropdowns need to know about one episode, open or returned. */
export interface ActivityRow {
  /** 'returned' or 'out'. Released episodes never reach the report. */
  status: string
  loadId: string
  batchId: string | null
  batchName: string | null
  strainName: string | null
  harvestDate: string | null
  trimmerId: string
  /** The name recorded on the checkout (a snapshot: it can differ between days if a display name was edited). */
  trimmerName: string
  /** ISO instant; decides which snapshot of a trimmer's name is the most recent. */
  checkedOutAt: string | null
}

export function narrowByBatch<T extends ActivityRow>(rows: readonly T[], batchId: string | null): T[] {
  return batchId ? rows.filter((r) => r.batchId === batchId) : [...rows]
}

export function narrowByTrimmer<T extends ActivityRow>(rows: readonly T[], trimmerId: string | null): T[] {
  return trimmerId ? rows.filter((r) => r.trimmerId === trimmerId) : [...rows]
}

interface LoadGroup<T> {
  first: T
  /** Every hanger with work in the group, returned or still out. */
  loads: Set<string>
  /** The hangers with at least one RETURNED episode (the Hangers tile's definition). */
  returnedLoads: Set<string>
}

/** Distinct hangers (loads) per key. A hanger worked twice in the range counts once. */
function loadsBy<T extends ActivityRow>(rows: readonly T[], key: (r: T) => string | null): Map<string, LoadGroup<T>> {
  const out = new Map<string, LoadGroup<T>>()
  for (const r of rows) {
    const k = key(r)
    if (k === null) continue
    let g = out.get(k)
    if (!g) {
      g = { first: r, loads: new Set(), returnedLoads: new Set() }
      out.set(k, g)
    }
    g.loads.add(r.loadId)
    if (r.status === 'returned') g.returnedLoads.add(r.loadId)
  }
  return out
}

/** Batches with activity in `rows` (pass the date range, before any batch or trimmer filter). Newest harvest first. */
export function deriveBatchOptions(rows: readonly ActivityRow[]): TrimBatchOption[] {
  const options = [...loadsBy(rows, (r) => r.batchId)].map(([id, g]) => ({
    id,
    name: g.first.batchName ?? 'Unnamed batch',
    strainName: g.first.strainName,
    harvestDate: g.first.harvestDate,
    hangers: g.loads.size,
    returnedHangers: g.returnedLoads.size,
  }))
  options.sort((a, b) => {
    if (a.harvestDate !== b.harvestDate) {
      if (a.harvestDate === null) return 1
      if (b.harvestDate === null) return -1
      return a.harvestDate < b.harvestDate ? 1 : -1
    }
    return a.name.localeCompare(b.name, 'en-US', { numeric: true })
  })
  return options
}

/**
 * Trimmers with activity in `rows` (pass the date range already narrowed to the selected batch). A to Z.
 * A trimmer's name is the most recent one recorded in the rows, so an edited display name shows as the new
 * one rather than whichever checkout happened to come first.
 */
export function deriveTrimmerOptions(rows: readonly ActivityRow[]): TrimTrimmerOption[] {
  const latest = new Map<string, ActivityRow>()
  for (const r of rows) {
    const cur = latest.get(r.trimmerId)
    if (!cur || (r.checkedOutAt ?? '') >= (cur.checkedOutAt ?? '')) latest.set(r.trimmerId, r)
  }
  const options = [...loadsBy(rows, (r) => r.trimmerId)].map(([id, g]) => ({
    id,
    name: latest.get(id)?.trimmerName ?? g.first.trimmerName,
    hangers: g.loads.size,
    returnedHangers: g.returnedLoads.size,
  }))
  options.sort((a, b) => a.name.localeCompare(b.name, 'en-US', { sensitivity: 'base' }))
  return options
}

/**
 * Keep the current selection in its list. When it has no activity it is not among the derived options, so it
 * is appended with a zero count (built by `make`, which knows the display name) instead of vanishing.
 */
export function withSelectedOption<O extends { id: string }>(
  options: readonly O[],
  selectedId: string | null,
  make: (id: string) => O
): O[] {
  if (!selectedId || options.some((o) => o.id === selectedId)) return [...options]
  return [...options, make(selectedId)]
}

// ─── Labels and copy ─────────────────────────────────────────────────────────

/**
 * The hanger count an option shows. Finished only on: returned hangers, the same set the Hangers tile counts.
 * Off: all assigned work, open hangers included. Display only; which options exist never depends on it.
 */
export function optionCount(o: Pick<TrimBatchOption, 'hangers' | 'returnedHangers'>, finishedOnly: boolean): number {
  return finishedOnly ? o.returnedHangers : o.hangers
}

/** "1001-F1-BB — Bubble Bath (18)". A selection with nothing shows "(0)". */
export function batchOptionLabel(
  o: Pick<TrimBatchOption, 'name' | 'strainName' | 'hangers' | 'returnedHangers'>,
  finishedOnly: boolean
): string {
  return `${o.name}${o.strainName ? ` — ${o.strainName}` : ''} (${optionCount(o, finishedOnly)})`
}

/** "Antonio (4)". */
export function trimmerOptionLabel(o: Pick<TrimTrimmerOption, 'name' | 'hangers' | 'returnedHangers'>, finishedOnly: boolean): string {
  return `${o.name} (${optionCount(o, finishedOnly)})`
}

/**
 * Why the table is empty. An empty result under a selection that has nothing says so ("Antonio has no
 * hangers in the selected range"), rather than a generic "no results" that hides which filter is responsible.
 * The batch is named first: if the batch has nothing in the range, no trimmer can have anything on it.
 */
export function emptyReportMessage(sel: {
  batchId: string | null
  trimmerId: string | null
  batchOptions: readonly TrimBatchOption[]
  trimmerOptions: readonly TrimTrimmerOption[]
}): string {
  const batch = sel.batchId ? sel.batchOptions.find((o) => o.id === sel.batchId) : undefined
  const trimmer = sel.trimmerId ? sel.trimmerOptions.find((o) => o.id === sel.trimmerId) : undefined
  if (batch && batch.hangers === 0) return `Batch ${batch.name} has no returned or checked-out hangers in the selected range.`
  if (trimmer && trimmer.hangers === 0) {
    return `${trimmer.name} has no returned or checked-out hangers${batch ? ` on batch ${batch.name}` : ''} in the selected range.`
  }
  return 'No hangers were returned or checked out in this range.'
}
