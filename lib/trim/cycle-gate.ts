// May a grow cycle be ended as 'completed'? (plan section 3, endCycle precondition)
//
// The gate only applies once the cycle has actually used the trim module:
//
//   - If NO batch in the cycle has any loads, the gate is open — legacy cycles
//     and cycles that never used the module behave exactly as before.
//   - If ANY batch has loads, then for every batch that has loads:
//       * every load must be reconciled or void (a `partial`, `returned`,
//         `checked_out`, `hung` or `dried` load blocks), and
//       * the batch must be trim-closed (trim_closed_at set).
//   - Declared-but-empty batches (declared at the harvest advance, never
//     weighed) only WARN; they never block.
//
// One deliberate exception to "trim-closed": a batch whose loads are ALL void
// has nothing to close (fn_trim_close_batch needs at least one reconciled load),
// so blocking on it would make the cycle un-endable forever. It warns instead.
//
// Returns named blockers (batch + hanger codes) so the UI can say exactly what
// to go fix. Cancelling a cycle is not gated — callers only invoke this for
// outcome === 'completed'.
//
// Pure: no imports from actions/, no I/O.

import type { HangerLoadStatus } from '@/types/harvest-trim'
import { LOAD_STATUSES, isOpenStatus } from './state-machine'

export interface CycleGateLoad {
  status: HangerLoadStatus
  /** e.g. H1B-042, used only to name blockers. */
  hangerCode?: string | null
}

export interface CycleGateBatch {
  id: string
  name: string
  trimClosedAt: string | null
  loads: readonly CycleGateLoad[]
}

/** How many hanger codes a blocker names before it says "and N more". */
export const MAX_NAMED_HANGERS = 10

export type CycleGateBlocker =
  | {
      kind: 'open_loads'
      batchId: string
      batchName: string
      count: number
      byStatus: Partial<Record<HangerLoadStatus, number>>
      hangerCodes: string[]
      message: string
    }
  | {
      kind: 'batch_not_closed'
      batchId: string
      batchName: string
      message: string
    }

export type CycleGateWarning =
  | { kind: 'declared_empty'; batchId: string; batchName: string; message: string }
  | { kind: 'all_loads_void'; batchId: string; batchName: string; message: string }

export interface CycleGateResult {
  canEnd: boolean
  /** True when any batch has loads, i.e. the gate was actually enforced. */
  gateActive: boolean
  blockers: CycleGateBlocker[]
  warnings: CycleGateWarning[]
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

export function evaluateCycleGate(batches: readonly CycleGateBatch[]): CycleGateResult {
  let gateActive = false
  for (const b of batches) {
    if (b.loads.length > 0) {
      gateActive = true
      break
    }
  }

  const blockers: CycleGateBlocker[] = []
  const warnings: CycleGateWarning[] = []

  for (const batch of batches) {
    const { id: batchId, name: batchName } = batch

    if (batch.loads.length === 0) {
      warnings.push({
        kind: 'declared_empty',
        batchId,
        batchName,
        message: `${batchName} was declared but has no hangers weighed.`,
      })
      continue
    }
    if (!gateActive) continue

    // One pass over the batch's loads.
    const byStatus: Partial<Record<HangerLoadStatus, number>> = {}
    const hangerCodes: string[] = []
    let open = 0
    let reconciled = 0
    for (const load of batch.loads) {
      if (isOpenStatus(load.status)) {
        open++
        byStatus[load.status] = (byStatus[load.status] ?? 0) + 1
        if (hangerCodes.length < MAX_NAMED_HANGERS && load.hangerCode) hangerCodes.push(load.hangerCode)
      } else if (load.status === 'reconciled') {
        reconciled++
      }
    }

    if (open > 0) {
      const breakdown = LOAD_STATUSES.filter((s) => byStatus[s]).map((s) => `${byStatus[s]} ${s.replace('_', ' ')}`)
      const more = open - hangerCodes.length
      const named = hangerCodes.length
        ? ` (${hangerCodes.join(', ')}${more > 0 ? `, and ${more} more` : ''})`
        : ''
      blockers.push({
        kind: 'open_loads',
        batchId,
        batchName,
        count: open,
        byStatus,
        hangerCodes,
        message: `${batchName}: ${open} ${plural(open, 'hanger is', 'hangers are')} not finished — ${breakdown.join(', ')}${named}.`,
      })
    } else if (reconciled === 0) {
      warnings.push({
        kind: 'all_loads_void',
        batchId,
        batchName,
        message: `${batchName} has only voided hangers, so there is nothing to close.`,
      })
    } else if (!batch.trimClosedAt) {
      blockers.push({
        kind: 'batch_not_closed',
        batchId,
        batchName,
        message: `${batchName}: all hangers are reconciled but the batch has not been closed.`,
      })
    }
  }

  return { canEnd: blockers.length === 0, gateActive, blockers, warnings }
}
