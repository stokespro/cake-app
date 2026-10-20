// Harvest & Trim: database error -> ActionResult mapping, shared by the four action files.
//
// Lives in lib/ because a 'use server' module may only export async functions
// (scripts/check-server-exports.mjs), so the helpers could not be shared from an actions/ file and
// used to be copy-pasted into each one.
//
// The mapping has three layers:
//   1. TRIM_E_<CODE>: <message>  raised by the fn_trim_* functions -> the matching ActionErrorCode,
//      with the human part of the message passed through.
//   2. 23505 on the two invariant indexes (one open load per hanger, one checkout out per load) ->
//      ALREADY_OUT / DUPLICATE_OPEN. Together with (1) this is the race-safe path: the index is the
//      guard, the action just translates its violation.
//   3. Caller-supplied constraint rules for table-specific violations (e.g. trim_staff's unique name).
// Anything else is logged and returned as a generic message, so internals never reach the client.
//
// mapDbError and the result constructors are pure. dbFailure is the one function that logs.

import type { ActionErrorCode, ActionResult } from '@/types/harvest-trim'

export const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function denied<T>(reason: string): ActionResult<T> {
  return { success: false, error: reason, code: 'FORBIDDEN' }
}

export function invalid<T>(message: string): ActionResult<T> {
  return { success: false, error: message, code: 'INVALID' }
}

export function fail<T>(error: string, code?: ActionErrorCode): ActionResult<T> {
  return code ? { success: false, error, code } : { success: false, error }
}

interface DbErrorLike {
  code?: string
  message?: string
  details?: string | null
}

/** The slice of a Postgres / PostgREST error the mapper reads. */
export type DbError = DbErrorLike

const TRIM_ERROR = /^TRIM_E_([A-Z_]+):\s*([\s\S]*)$/

/** The suffix after TRIM_E_ -> ActionErrorCode. An unknown suffix falls back to INVALID. */
export const TRIM_CODE_MAP: Readonly<Record<string, ActionErrorCode>> = {
  NOT_FOUND: 'NOT_FOUND',
  STATE: 'STATE',
  INVALID: 'INVALID',
  FORBIDDEN: 'FORBIDDEN',
  DUPLICATE_OPEN: 'DUPLICATE_OPEN',
  ALREADY_OUT: 'ALREADY_OUT',
  BATCH_REQUIRED: 'BATCH_REQUIRED',
  DUPLICATE_NAME: 'DUPLICATE_NAME',
  NO_VENDOR: 'NO_VENDOR',
  ALREADY_APPROVED: 'ALREADY_APPROVED',
  HAS_PAYMENTS: 'HAS_PAYMENTS',
  RECONCILE: 'RECONCILE',
}

/** The two invariant indexes every action file translates (see header). */
const INVARIANT_INDEX_RULES: readonly ConstraintRule[] = [
  {
    sqlState: '23505',
    match: 'uidx_trim_checkouts_one_out_per_load',
    message: 'That hanger is already checked out.',
    code: 'ALREADY_OUT',
  },
  {
    sqlState: '23505',
    match: 'uidx_hanger_loads_one_open_per_hanger',
    message: 'That hanger already has an open load.',
    code: 'DUPLICATE_OPEN',
  },
]

/**
 * A table-specific constraint violation to translate. `match` is looked for in the error's message
 * and details (Postgres names the violated constraint or index in one of them).
 */
export interface ConstraintRule {
  sqlState: '23505' | '23503'
  match: string
  message: string
  code: ActionErrorCode
}

export interface MappedDbError {
  message: string
  code: ActionErrorCode
}

/**
 * Translate a database error into a business error, or null when it is not one we recognise (the
 * caller then logs it and returns GENERIC_ERROR). `extraRules` are checked after the invariant
 * indexes.
 */
export function mapDbError(err: unknown, extraRules: readonly ConstraintRule[] = []): MappedDbError | null {
  const e = (err ?? {}) as DbErrorLike
  const message = typeof e.message === 'string' ? e.message : ''

  if (e.code === undefined || e.code === 'P0001') {
    const m = TRIM_ERROR.exec(message)
    if (m) return { message: m[2].trim() || GENERIC_ERROR, code: TRIM_CODE_MAP[m[1]] ?? 'INVALID' }
  }

  if (e.code === '23505' || e.code === '23503') {
    const hay = `${message} ${e.details ?? ''}`
    for (const rule of [...INVARIANT_INDEX_RULES, ...extraRules]) {
      if (rule.sqlState === e.code && hay.includes(rule.match)) return { message: rule.message, code: rule.code }
    }
  }
  return null
}

/**
 * Map a Postgres / PostgREST / thrown error to an ActionResult. Business errors keep their message;
 * anything else is logged as `[harvest-trim] <fn> error:` and returned generic.
 */
export function dbFailure<T>(fn: string, err: unknown, extraRules: readonly ConstraintRule[] = []): ActionResult<T> {
  const mapped = mapDbError(err, extraRules)
  if (mapped) return fail(mapped.message, mapped.code)
  console.error(`[harvest-trim] ${fn} error:`, err)
  return fail(GENERIC_ERROR)
}
