import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GENERIC_ERROR,
  TRIM_CODE_MAP,
  dbFailure,
  denied,
  fail,
  invalid,
  mapDbError,
  type ConstraintRule,
} from './db-errors'

describe('result constructors', () => {
  it('denied / invalid carry their code', () => {
    expect(denied('nope')).toEqual({ success: false, error: 'nope', code: 'FORBIDDEN' })
    expect(invalid('bad')).toEqual({ success: false, error: 'bad', code: 'INVALID' })
  })

  it('fail omits the code key entirely when none is given', () => {
    expect(fail('x')).toEqual({ success: false, error: 'x' })
    expect('code' in fail('x')).toBe(false)
    expect(fail('x', 'STATE')).toEqual({ success: false, error: 'x', code: 'STATE' })
  })
})

describe('mapDbError: TRIM_E_* codes', () => {
  const CODES = [
    'NOT_FOUND',
    'STATE',
    'INVALID',
    'FORBIDDEN',
    'DUPLICATE_OPEN',
    'ALREADY_OUT',
    'BATCH_REQUIRED',
    'DUPLICATE_NAME',
    'NO_VENDOR',
    'ALREADY_APPROVED',
    'HAS_PAYMENTS',
    'RECONCILE',
  ] as const

  it('the code table covers exactly the codes the SQL functions raise', () => {
    expect(Object.keys(TRIM_CODE_MAP).sort()).toEqual([...CODES].sort())
  })

  it.each(CODES)('TRIM_E_%s maps to the same ActionErrorCode and keeps the human message', (code) => {
    expect(mapDbError({ code: 'P0001', message: `TRIM_E_${code}: the human message` })).toEqual({
      message: 'the human message',
      code,
    })
  })

  it('DUPLICATE_NAME is its own code, not collapsed into INVALID', () => {
    expect(mapDbError({ code: 'P0001', message: 'TRIM_E_DUPLICATE_NAME: a batch named X already exists' })?.code).toBe(
      'DUPLICATE_NAME'
    )
  })

  it.each(['NO_VENDOR', 'ALREADY_APPROVED', 'HAS_PAYMENTS', 'RECONCILE'] as const)(
    '%s is its own code, not collapsed into INVALID or STATE',
    (code) => {
      expect(mapDbError({ code: 'P0001', message: `TRIM_E_${code}: the human message` })?.code).toBe(code)
    }
  )

  it('accepts an error with no SQLSTATE (a thrown Error from a wrapper)', () => {
    expect(mapDbError(new Error('TRIM_E_STATE: not now'))).toEqual({ message: 'not now', code: 'STATE' })
  })

  it('does not treat the prefix as a business error under a different SQLSTATE', () => {
    expect(mapDbError({ code: '42501', message: 'TRIM_E_STATE: spoofed' })).toBeNull()
  })

  it('an unknown TRIM_E_ suffix falls back to INVALID with its message', () => {
    expect(mapDbError({ code: 'P0001', message: 'TRIM_E_WHATEVER: odd one' })).toEqual({
      message: 'odd one',
      code: 'INVALID',
    })
  })

  it('an empty human part becomes the generic message, keeping the code', () => {
    expect(mapDbError({ code: 'P0001', message: 'TRIM_E_STATE:   ' })).toEqual({ message: GENERIC_ERROR, code: 'STATE' })
  })

  it('keeps a multi-line human message intact (trimmed)', () => {
    expect(mapDbError({ code: 'P0001', message: 'TRIM_E_INVALID: line one\nline two ' })?.message).toBe('line one\nline two')
  })

  it('only matches at the start of the message', () => {
    expect(mapDbError({ code: 'P0001', message: 'oops TRIM_E_STATE: x' })).toBeNull()
  })
})

describe('mapDbError: unique-index violations (23505)', () => {
  it('uidx_trim_checkouts_one_out_per_load -> ALREADY_OUT', () => {
    expect(
      mapDbError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "uidx_trim_checkouts_one_out_per_load"',
      })
    ).toEqual({ message: 'That hanger is already checked out.', code: 'ALREADY_OUT' })
  })

  it('uidx_hanger_loads_one_open_per_hanger -> DUPLICATE_OPEN', () => {
    expect(
      mapDbError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "uidx_hanger_loads_one_open_per_hanger"',
      })
    ).toEqual({ message: 'That hanger already has an open load.', code: 'DUPLICATE_OPEN' })
  })

  it('finds the index name in `details` as well as `message`', () => {
    expect(
      mapDbError({ code: '23505', message: 'conflict', details: 'index uidx_hanger_loads_one_open_per_hanger' })?.code
    ).toBe('DUPLICATE_OPEN')
  })

  it('an unrelated unique violation is not mapped', () => {
    expect(mapDbError({ code: '23505', message: 'violates unique constraint "some_other_idx"' })).toBeNull()
  })

  it('the index names only count under their own SQLSTATE', () => {
    expect(mapDbError({ code: '23503', message: 'uidx_trim_checkouts_one_out_per_load' })).toBeNull()
  })
})

describe('mapDbError: caller-supplied constraint rules', () => {
  const RULES: ConstraintRule[] = [
    { sqlState: '23505', match: 'uidx_trim_staff_active_name', message: 'Name taken.', code: 'INVALID' },
    { sqlState: '23503', match: 'vendor', message: 'No such vendor.', code: 'INVALID' },
  ]

  it('applies them under the matching SQLSTATE only', () => {
    expect(mapDbError({ code: '23505', message: 'uidx_trim_staff_active_name' }, RULES)).toEqual({
      message: 'Name taken.',
      code: 'INVALID',
    })
    expect(mapDbError({ code: '23503', message: 'trim_staff_vendor_id_fkey' }, RULES)).toEqual({
      message: 'No such vendor.',
      code: 'INVALID',
    })
    expect(mapDbError({ code: '23503', message: 'uidx_trim_staff_active_name' }, RULES)).toBeNull()
  })

  it('without the rules the same errors are unmapped', () => {
    expect(mapDbError({ code: '23505', message: 'uidx_trim_staff_active_name' })).toBeNull()
  })

  it('the shared invariant indexes win over a caller rule that also matches', () => {
    const greedy: ConstraintRule[] = [{ sqlState: '23505', match: 'uidx_', message: 'greedy', code: 'INVALID' }]
    expect(mapDbError({ code: '23505', message: 'uidx_trim_checkouts_one_out_per_load' }, greedy)?.code).toBe('ALREADY_OUT')
  })
})

describe('mapDbError: robustness', () => {
  it.each([null, undefined, {}, 'a string', 42, { message: 7 }])('returns null for %j', (err) => {
    expect(mapDbError(err)).toBeNull()
  })
})

describe('dbFailure', () => {
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => spy.mockRestore())

  it('returns a mapped business error without logging', () => {
    expect(dbFailure('fn', { code: 'P0001', message: 'TRIM_E_NOT_FOUND: no such load' })).toEqual({
      success: false,
      error: 'no such load',
      code: 'NOT_FOUND',
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('hides anything else behind the generic message and logs the real error', () => {
    const err = { code: '23514', message: 'new row violates check constraint "co_ok_within_threshold"' }
    const result = dbFailure('voidLoad', err)
    expect(result).toEqual({ success: false, error: GENERIC_ERROR })
    expect(JSON.stringify(result)).not.toContain('co_ok_within_threshold')
    expect(spy).toHaveBeenCalledWith('[harvest-trim] voidLoad error:', err)
  })

  it('passes extra rules through', () => {
    const rules: ConstraintRule[] = [{ sqlState: '23505', match: 'idx_x', message: 'dup', code: 'INVALID' }]
    expect(dbFailure('fn', { code: '23505', message: 'idx_x' }, rules)).toEqual({
      success: false,
      error: 'dup',
      code: 'INVALID',
    })
  })
})
