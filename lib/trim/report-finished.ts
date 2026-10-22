// Harvest & Trim reports: the "Finished only" display preference.
//
// ON  -> the hanger table lists RETURNED rows only (status 'returned': both return kinds, 'complete' and
//        'unfinished'). OFF -> it also lists the hangers still checked out (status 'out'), i.e. all assigned work.
//
// NAMING TRAP. "Finished" here is about the checkout STATUS (back or still out). It has nothing to do with
// `return_kind === 'unfinished'`, which is a RETURN that came back part-trimmed, carries real flower and pay,
// and counts in every figure. Those rows are returned, so they show in both modes and keep their tag.
//
// It is a display preference only, same class as the column choice: it filters which rows are LISTED
// (lib/trim/report-table.ts) and which count the dropdown options show (lib/trim/report-options.ts), and it
// never reaches the action, a total, a subtotal or a pay figure. Kept per device in localStorage, not in the
// URL, and not reset by Clear Filters.
//
// Storage is untrusted input (any string, or nothing): parsing never throws and anything that is not a
// stored boolean falls back to the default.
//
// Pure: no React, no I/O beyond the Storage object a caller hands in.

/** Default ON: the page's job is completed work and pay; open hangers are the opt-in extra. */
export const DEFAULT_FINISHED_ONLY = true

/** Same prefix as the module's other preferences (harvest-trim-report-columns, ...). */
export const FINISHED_ONLY_STORE_KEY = 'harvest-trim-report-finished-only'

/** The stored string as a boolean; null, '', bad JSON or any non-boolean value yields the default. Never throws. */
export function parseStoredFinishedOnly(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_FINISHED_ONLY
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'boolean' ? v : DEFAULT_FINISHED_ONLY
  } catch {
    return DEFAULT_FINISHED_ONLY
  }
}

export function readStoredFinishedOnly(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const s = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    return parseStoredFinishedOnly(s ? s.getItem(FINISHED_ONLY_STORE_KEY) : null)
  } catch {
    // Storage disabled / denied: behave as if nothing was stored.
    return DEFAULT_FINISHED_ONLY
  }
}

/** Persist (or, for the default, forget) the choice. Failure just means it won't be remembered. */
export function writeStoredFinishedOnly(finishedOnly: boolean, storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
  try {
    const s = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    if (!s) return
    if (finishedOnly === DEFAULT_FINISHED_ONLY) s.removeItem(FINISHED_ONLY_STORE_KEY)
    else s.setItem(FINISHED_ONLY_STORE_KEY, JSON.stringify(finishedOnly))
  } catch {
    // The preference just won't stick.
  }
}
