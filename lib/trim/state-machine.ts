// Hanger-load state machine (plan section 1 as revised by R2.2 and R2.12), as DATA.
//
// The DB functions (fn_trim_*) are the authority — they lock the load row and
// assert the prior status in every UPDATE. This table exists so actions can
// give a friendly pre-check error ("H1B-042 is already checked out") instead of
// a raw TRIM_E_STATE, and so the UI can decide which buttons to show.
//
//   statuses:  hung, dried, checked_out, partial, returned, reconciled, void
//   terminal:  reconciled, void
//   `partial` = an unfinished return came back in threshold: plants are still
//   on the hanger. It counts as OPEN (one open load per hanger) and is the
//   only post-return status a load can be re-issued from.
//
// R2.12: there is NO writeOffRemainder. The one escape hatch is voiding a
// `partial` load, and that is admin-only (TRIM_ADMIN_ROLES) so a stuck hanger
// can never make a batch permanently unclosable.
//
// Several actions are "state-dependent" and appear as one row with more than
// one target (releaseCheckout goes back to dried OR partial, depending on
// whether any episode ever came back; correctReturn / resolveVariance re-derive
// the status from the corrected weights). Which target applies is decided in
// SQL from data this table can't see, so canTransition() answers "is this
// (from, to) reachable by this role at all".
//
// Pure: no imports from actions/, no I/O.

import type { HangerLoadStatus } from '@/types/harvest-trim'
import {
  HARVEST_WEIGH_ROLES,
  TRIM_ADMIN_ROLES,
  TRIM_OPS_ROLES,
  roleAllowed,
} from './roles'

export const LOAD_STATUSES: readonly HangerLoadStatus[] = [
  'hung',
  'dried',
  'checked_out',
  'partial',
  'returned',
  'reconciled',
  'void',
]

/** Terminal: no transition leaves these (reopenLoad is the audited exception for `reconciled`). */
export const TERMINAL_STATUSES: readonly HangerLoadStatus[] = ['reconciled', 'void']

/** "Open" for the one-open-load-per-hanger invariant. A `partial` load is open. */
export function isOpenStatus(status: HangerLoadStatus): boolean {
  return status !== 'reconciled' && status !== 'void'
}

export function isTerminalStatus(status: HangerLoadStatus): boolean {
  return status === 'reconciled' || status === 'void'
}

export type TransitionAction =
  | 'recordHarvestWeight'
  | 'createLateEntryLoad'
  | 'recordDryWeight'
  | 'correctDryWeight'
  | 'checkOutLoad'
  | 'releaseCheckout'
  | 'checkInLoad'
  | 'correctReturn'
  | 'resolveVariance'
  | 'reopenLoad'
  | 'voidLoad'

export interface TransitionRule {
  /** Stable id from the plan's table, for tests and docs. */
  id: string
  action: TransitionAction
  /** `null` = the load does not exist yet (creation). */
  from: readonly (HangerLoadStatus | null)[]
  to: readonly HangerLoadStatus[]
  roles: readonly string[]
  note?: string
}

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    id: '1',
    action: 'recordHarvestWeight',
    from: [null],
    to: ['hung'],
    roles: HARVEST_WEIGH_ROLES,
    note: 'scan, plants, wet weight',
  },
  {
    id: '1b',
    action: 'createLateEntryLoad',
    from: [null],
    to: ['dried'],
    roles: TRIM_OPS_ROLES,
    note: 'hangers already drying on paper; wet and plants optional',
  },
  { id: '2', action: 'recordDryWeight', from: ['hung'], to: ['dried'], roles: TRIM_OPS_ROLES },
  {
    id: '3',
    action: 'correctDryWeight',
    from: ['dried'],
    to: ['dried'],
    roles: TRIM_OPS_ROLES,
    note: 'audited; only while no returned episode exists',
  },
  {
    id: '4',
    action: 'checkOutLoad',
    from: ['hung', 'dried', 'partial'],
    to: ['checked_out'],
    roles: TRIM_OPS_ROLES,
    note: 'issues remaining_g on a partial; same or different trimmer',
  },
  {
    id: '5',
    action: 'releaseCheckout',
    from: ['checked_out'],
    to: ['dried', 'partial'],
    roles: TRIM_OPS_ROLES,
    note: 'dried if no episode ever returned, else partial; reason required',
  },
  {
    id: '6',
    action: 'checkInLoad',
    from: ['checked_out'],
    to: ['reconciled'],
    roles: TRIM_OPS_ROLES,
    note: 'complete return, in threshold; creates the pay entry',
  },
  {
    id: '6b',
    action: 'checkInLoad',
    from: ['checked_out'],
    to: ['partial'],
    roles: TRIM_OPS_ROLES,
    note: 'unfinished return, in threshold; offers Reissue now',
  },
  {
    id: '7',
    action: 'checkInLoad',
    from: ['checked_out'],
    to: ['returned'],
    roles: TRIM_OPS_ROLES,
    note: 'either kind, flagged; a flagged unfinished return blocks reissue',
  },
  {
    id: '8',
    action: 'correctReturn',
    from: ['returned', 'partial'],
    to: ['returned', 'reconciled', 'partial'],
    roles: TRIM_OPS_ROLES,
    note: 'newest episode only; may change the return kind',
  },
  {
    id: '9',
    action: 'resolveVariance',
    from: ['returned'],
    to: ['reconciled', 'partial'],
    roles: TRIM_OPS_ROLES,
    note: 'accept with a mandatory reason',
  },
  {
    id: '10',
    action: 'reopenLoad',
    from: ['reconciled'],
    to: ['returned'],
    roles: TRIM_ADMIN_ROLES,
    note: 'newest episode only; blocked once its pay entry is approved',
  },
  {
    id: '11',
    action: 'voidLoad',
    from: ['hung', 'dried'],
    to: ['void'],
    roles: TRIM_OPS_ROLES,
    note: 'reason required',
  },
  {
    id: '11b',
    action: 'voidLoad',
    from: ['partial'],
    to: ['void'],
    roles: TRIM_ADMIN_ROLES,
    note: 'R2.12: the admin-only escape so a stuck hanger cannot block a batch close',
  },
]

// Index by (from,to) once at load time so lookups are O(1) rather than a scan
// of the table per call — canTransition() runs per row when rendering a board.
const NEW = 'new'
const key = (from: HangerLoadStatus | null, to: HangerLoadStatus) => `${from ?? NEW}>${to}`

const BY_EDGE = new Map<string, TransitionRule[]>()
const BY_ACTION = new Map<TransitionAction, TransitionRule[]>()
for (const rule of TRANSITIONS) {
  for (const from of rule.from) {
    for (const to of rule.to) {
      const k = key(from, to)
      const list = BY_EDGE.get(k)
      if (list) list.push(rule)
      else BY_EDGE.set(k, [rule])
    }
  }
  const list = BY_ACTION.get(rule.action)
  if (list) list.push(rule)
  else BY_ACTION.set(rule.action, [rule])
}

/**
 * Can `role` move a load from `from` to `to`? `from = null` is creation. True
 * if ANY rule covers the edge for that role. Unknown roles and statuses are
 * denied; terminal states have no outgoing edges except reopenLoad.
 */
export function canTransition(
  from: HangerLoadStatus | null,
  to: HangerLoadStatus,
  role: string | null | undefined
): boolean {
  const rules = BY_EDGE.get(key(from, to))
  if (!rules) return false
  for (const rule of rules) if (roleAllowed(rule.roles, role)) return true
  return false
}

/**
 * Can `role` perform `action` on a load currently in `from` (null = creating
 * one)? Used for pre-checks where the target depends on data in SQL.
 */
export function canPerform(
  action: TransitionAction,
  from: HangerLoadStatus | null,
  role: string | null | undefined
): boolean {
  const rules = BY_ACTION.get(action)
  if (!rules) return false
  for (const rule of rules) {
    if (rule.from.includes(from) && roleAllowed(rule.roles, role)) return true
  }
  return false
}

/** Actions `role` may take on a load in `from`, in table order, de-duplicated. For button visibility. */
export function availableActions(
  from: HangerLoadStatus | null,
  role: string | null | undefined
): TransitionAction[] {
  const out: TransitionAction[] = []
  for (const rule of TRANSITIONS) {
    if (rule.from.includes(from) && roleAllowed(rule.roles, role) && !out.includes(rule.action)) {
      out.push(rule.action)
    }
  }
  return out
}
