// Role x capability matrix. The expectations are written out longhand (not
// derived from the arrays under test) so an accidental widening fails loudly.

import { describe, expect, it } from 'vitest'
import {
  TRIM_VIEW_ROLES,
  HARVEST_WEIGH_ROLES,
  TRIM_OPS_ROLES,
  TRIM_STAFF_ADMIN_ROLES,
  TRIM_PAY_APPROVE_ROLES,
  TRIM_ADMIN_ROLES,
  roleAllowed,
} from './roles'
import { USER_ROLES } from '@/lib/auth/session-constants'

const sorted = (a: string[]) => [...a].sort()

describe('role sets: exact membership', () => {
  it('TRIM_VIEW_ROLES', () => {
    expect(sorted(TRIM_VIEW_ROLES)).toEqual(['admin', 'grow', 'management', 'trim_manager'])
  })
  it('HARVEST_WEIGH_ROLES', () => {
    expect(sorted(HARVEST_WEIGH_ROLES)).toEqual(['admin', 'grow', 'management', 'trim_manager'])
  })
  it('TRIM_OPS_ROLES', () => {
    expect(sorted(TRIM_OPS_ROLES)).toEqual(['admin', 'management', 'trim_manager'])
  })
  it('TRIM_STAFF_ADMIN_ROLES includes trim_manager (R2.15)', () => {
    expect(sorted(TRIM_STAFF_ADMIN_ROLES)).toEqual(['admin', 'management', 'trim_manager'])
  })
  it('TRIM_PAY_APPROVE_ROLES includes trim_manager (R2.14)', () => {
    expect(sorted(TRIM_PAY_APPROVE_ROLES)).toEqual(['admin', 'management', 'trim_manager'])
  })
  it('TRIM_ADMIN_ROLES excludes trim_manager', () => {
    expect(sorted(TRIM_ADMIN_ROLES)).toEqual(['admin', 'management'])
  })
})

describe('role x capability matrix', () => {
  // [role, view, weigh, ops, staffAdmin, payApprove, admin]
  const matrix: Array<[string, boolean, boolean, boolean, boolean, boolean, boolean]> = [
    ['admin', true, true, true, true, true, true],
    ['management', true, true, true, true, true, true],
    ['trim_manager', true, true, true, true, true, false],
    ['grow', true, true, false, false, false, false],
    ['packaging', false, false, false, false, false, false],
    ['vault', false, false, false, false, false, false],
    ['standard', false, false, false, false, false, false],
    ['sales', false, false, false, false, false, false],
    ['agent', false, false, false, false, false, false],
  ]

  it.each(matrix)('%s', (role, view, weigh, ops, staffAdmin, payApprove, admin) => {
    expect(roleAllowed(TRIM_VIEW_ROLES, role)).toBe(view)
    expect(roleAllowed(HARVEST_WEIGH_ROLES, role)).toBe(weigh)
    expect(roleAllowed(TRIM_OPS_ROLES, role)).toBe(ops)
    expect(roleAllowed(TRIM_STAFF_ADMIN_ROLES, role)).toBe(staffAdmin)
    expect(roleAllowed(TRIM_PAY_APPROVE_ROLES, role)).toBe(payApprove)
    expect(roleAllowed(TRIM_ADMIN_ROLES, role)).toBe(admin)
  })

  it('the matrix covers every real role', () => {
    expect(sorted(matrix.map((r) => r[0]))).toEqual(sorted([...USER_ROLES]))
  })

  it('every set only names real roles', () => {
    for (const set of [
      TRIM_VIEW_ROLES,
      HARVEST_WEIGH_ROLES,
      TRIM_OPS_ROLES,
      TRIM_STAFF_ADMIN_ROLES,
      TRIM_PAY_APPROVE_ROLES,
      TRIM_ADMIN_ROLES,
    ]) {
      for (const r of set) expect(USER_ROLES).toContain(r)
    }
  })

  it('every narrower set is a subset of the view/weigh set', () => {
    for (const set of [TRIM_OPS_ROLES, TRIM_STAFF_ADMIN_ROLES, TRIM_PAY_APPROVE_ROLES, TRIM_ADMIN_ROLES]) {
      for (const r of set) expect(TRIM_VIEW_ROLES).toContain(r)
    }
  })

  it('denies null, undefined and empty roles', () => {
    expect(roleAllowed(TRIM_VIEW_ROLES, null)).toBe(false)
    expect(roleAllowed(TRIM_VIEW_ROLES, undefined)).toBe(false)
    expect(roleAllowed(TRIM_VIEW_ROLES, '')).toBe(false)
  })

  it('role match is exact (no case folding)', () => {
    expect(roleAllowed(TRIM_OPS_ROLES, 'Admin')).toBe(false)
  })
})
