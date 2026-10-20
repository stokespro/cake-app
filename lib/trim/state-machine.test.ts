// Table-driven: the expectations below are written out longhand from plan
// section 1 / R2.2 / R2.12 (NOT derived from TRANSITIONS), then every
// (from, to, role) combination is checked in both directions — legal ones pass
// for exactly their roles, everything else fails.

import { describe, expect, it } from 'vitest'
import {
  LOAD_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  availableActions,
  canPerform,
  canTransition,
  isOpenStatus,
  isTerminalStatus,
} from './state-machine'
import type { HangerLoadStatus } from '@/types/harvest-trim'

type From = HangerLoadStatus | null

const OPS = ['admin', 'management', 'trim_manager']
const WEIGH = ['admin', 'management', 'trim_manager', 'grow']
const ADMIN = ['admin', 'management']

const ALL_ROLES = ['admin', 'management', 'sales', 'standard', 'vault', 'packaging', 'agent', 'grow', 'trim_manager']

// The complete set of legal edges and who may take them.
const LEGAL: Array<[From, HangerLoadStatus, string[]]> = [
  [null, 'hung', WEIGH], // 1  recordHarvestWeight
  [null, 'dried', OPS], // 1b createLateEntryLoad
  ['hung', 'dried', OPS], // 2  recordDryWeight
  ['dried', 'dried', OPS], // 3  correctDryWeight
  ['hung', 'checked_out', OPS], // 4
  ['dried', 'checked_out', OPS], // 4
  ['partial', 'checked_out', OPS], // 4  reissue
  ['checked_out', 'dried', OPS], // 5  release, no episode ever returned
  ['checked_out', 'partial', OPS], // 5 / 6b release or unfinished in-threshold return
  ['checked_out', 'reconciled', OPS], // 6  complete, in threshold
  ['checked_out', 'returned', OPS], // 7  flagged
  ['returned', 'returned', OPS], // 8  correctReturn still flagged
  ['returned', 'reconciled', OPS], // 8 / 9
  ['returned', 'partial', OPS], // 8 / 9
  ['partial', 'returned', OPS], // 8
  ['partial', 'partial', OPS], // 8
  ['partial', 'reconciled', OPS], // 8
  ['reconciled', 'returned', ADMIN], // 10 reopenLoad
  ['hung', 'void', OPS], // 11
  ['dried', 'void', OPS], // 11
  ['partial', 'void', ADMIN], // 11b R2.12
]

const legalKey = (from: From, to: HangerLoadStatus) => `${from}>${to}`
const LEGAL_MAP = new Map(LEGAL.map(([f, t, roles]) => [legalKey(f, t), roles]))

describe('canTransition: every (from, to, role) combination', () => {
  const froms: From[] = [null, ...LOAD_STATUSES]
  it('legal edges pass for exactly their roles; everything else fails', () => {
    let checked = 0
    for (const from of froms) {
      for (const to of LOAD_STATUSES) {
        const roles = LEGAL_MAP.get(legalKey(from, to)) ?? []
        for (const role of ALL_ROLES) {
          const expected = roles.includes(role)
          if (canTransition(from, to, role) !== expected) {
            throw new Error(`${from} -> ${to} as ${role}: expected ${expected}`)
          }
          checked++
        }
      }
    }
    expect(checked).toBe(8 * 7 * ALL_ROLES.length)
  })

  it('has exactly the expected number of legal edges', () => {
    let legal = 0
    for (const from of froms) {
      for (const to of LOAD_STATUSES) if (canTransition(from, to, 'admin')) legal++
    }
    expect(legal).toBe(LEGAL.length)
  })

  it('denies unknown, null and undefined roles', () => {
    for (const role of ['', 'owner', 'ADMIN', null, undefined]) {
      expect(canTransition('hung', 'dried', role)).toBe(false)
    }
  })
})

describe('named rules from the plan', () => {
  it('grow can create a harvest load but nothing at the trim station', () => {
    expect(canTransition(null, 'hung', 'grow')).toBe(true)
    expect(canTransition(null, 'dried', 'grow')).toBe(false)
    expect(canTransition('hung', 'dried', 'grow')).toBe(false)
    expect(canTransition('hung', 'checked_out', 'grow')).toBe(false)
  })

  it('trim_manager runs the station but cannot reopen a reconciled load', () => {
    expect(canTransition('checked_out', 'reconciled', 'trim_manager')).toBe(true)
    expect(canTransition('reconciled', 'returned', 'trim_manager')).toBe(false)
    expect(canTransition('reconciled', 'returned', 'management')).toBe(true)
  })

  it('R2.12: voiding a partial load is admin-tier only; hung/dried stay trim-ops', () => {
    expect(canTransition('partial', 'void', 'trim_manager')).toBe(false)
    expect(canTransition('partial', 'void', 'management')).toBe(true)
    expect(canTransition('partial', 'void', 'admin')).toBe(true)
    expect(canTransition('hung', 'void', 'trim_manager')).toBe(true)
    expect(canTransition('dried', 'void', 'trim_manager')).toBe(true)
  })

  it('cannot void once checked out, returned or reconciled', () => {
    for (const from of ['checked_out', 'returned', 'reconciled'] as const) {
      expect(canTransition(from, 'void', 'admin')).toBe(false)
    }
  })

  it('a partial load can be reissued; a flagged return cannot', () => {
    expect(canTransition('partial', 'checked_out', 'trim_manager')).toBe(true)
    expect(canTransition('returned', 'checked_out', 'admin')).toBe(false)
  })

  it('checked_out loads cannot be checked out again (one holder at a time)', () => {
    expect(canTransition('checked_out', 'checked_out', 'admin')).toBe(false)
  })

  it('a hung load cannot skip to a return', () => {
    for (const to of ['reconciled', 'returned', 'partial'] as const) {
      expect(canTransition('hung', to, 'admin')).toBe(false)
    }
  })

  it('dry weight correction is dried-only', () => {
    expect(canPerform('correctDryWeight', 'dried', 'trim_manager')).toBe(true)
    expect(canPerform('correctDryWeight', 'partial', 'trim_manager')).toBe(false)
    expect(canPerform('correctDryWeight', 'hung', 'trim_manager')).toBe(false)
    expect(canPerform('correctDryWeight', 'checked_out', 'admin')).toBe(false)
  })

  it('release only applies to a checked-out load', () => {
    expect(canPerform('releaseCheckout', 'checked_out', 'trim_manager')).toBe(true)
    expect(canPerform('releaseCheckout', 'dried', 'trim_manager')).toBe(false)
  })

  it('there is no writeOffRemainder (R2.12)', () => {
    const actions = TRANSITIONS.map((r) => r.action as string)
    expect(actions).not.toContain('writeOffRemainder')
    expect(canPerform('writeOffRemainder' as never, 'partial', 'admin')).toBe(false)
  })
})

describe('terminal and open states', () => {
  it('reconciled and void are terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['reconciled', 'void'])
    expect(isTerminalStatus('reconciled')).toBe(true)
    expect(isTerminalStatus('void')).toBe(true)
    expect(isTerminalStatus('partial')).toBe(false)
  })

  it('void has no outgoing edge at all', () => {
    for (const to of LOAD_STATUSES) {
      for (const role of ALL_ROLES) expect(canTransition('void', to, role)).toBe(false)
    }
  })

  it('reconciled only leaves via the audited reopen', () => {
    for (const to of LOAD_STATUSES) {
      expect(canTransition('reconciled', to, 'admin')).toBe(to === 'returned')
    }
  })

  it('a partial load counts as open (one open load per hanger)', () => {
    expect(isOpenStatus('partial')).toBe(true)
    for (const s of ['hung', 'dried', 'checked_out', 'returned'] as const) expect(isOpenStatus(s)).toBe(true)
    expect(isOpenStatus('reconciled')).toBe(false)
    expect(isOpenStatus('void')).toBe(false)
  })
})

describe('availableActions', () => {
  it('a dried load offers dry correction, checkout and void to trim ops', () => {
    expect(availableActions('dried', 'trim_manager')).toEqual(['correctDryWeight', 'checkOutLoad', 'voidLoad'])
  })
  it('a checked-out load offers release and check-in', () => {
    expect(availableActions('checked_out', 'trim_manager')).toEqual(['releaseCheckout', 'checkInLoad'])
  })
  it('a partial load offers reissue, return correction and (admin) void', () => {
    expect(availableActions('partial', 'trim_manager')).toEqual(['checkOutLoad', 'correctReturn'])
    expect(availableActions('partial', 'management')).toEqual(['checkOutLoad', 'correctReturn', 'voidLoad'])
  })
  it('creation for grow is only the harvest weigh-in', () => {
    expect(availableActions(null, 'grow')).toEqual(['recordHarvestWeight'])
  })
  it('a voided load offers nothing; roles outside the module get nothing', () => {
    expect(availableActions('void', 'admin')).toEqual([])
    expect(availableActions('dried', 'packaging')).toEqual([])
  })
})

describe('table integrity', () => {
  it('rule ids are unique', () => {
    const ids = TRANSITIONS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('every status named by a rule is a real status, and every status is reachable', () => {
    const reached = new Set<HangerLoadStatus>()
    for (const r of TRANSITIONS) {
      for (const f of r.from) if (f !== null) expect(LOAD_STATUSES).toContain(f)
      for (const t of r.to) {
        expect(LOAD_STATUSES).toContain(t)
        reached.add(t)
      }
    }
    expect([...reached].sort()).toEqual([...LOAD_STATUSES].sort())
  })
})
