// Harvest & Trim reports: which columns of the hanger table are shown.
//
// The choice is a per-device preference kept in localStorage. What is stored is the set of HIDDEN columns,
// not the visible ones, so a column added later shows up for everyone instead of being invisible to anyone
// who has ever touched the selector. Storage is untrusted input: it may be malformed, stale (a column that
// no longer exists) or written by a different role on a shared device, so it is always run through
// parseStoredColumns and then resolveVisibleColumns, and neither may throw.
//
// Pay is a money column. For a viewer without pay access (`grow`) it is removed HERE, after the stored
// preference is applied and before anything renders: it is not in the visible set and not in the selector
// (selectableColumns), whatever was stored. The server independently returns null for every dollar field.
//
// Pure: no React, no I/O beyond the Storage object a caller hands in.

export type ReportColumnKey =
  | 'hanger'
  | 'batch'
  | 'trimmer'
  | 'outIn'
  | 'issued'
  | 'flower'
  | 'trim'
  | 'stems'
  | 'variance'
  | 'status'
  | 'pay'

export interface ReportColumnDef {
  key: ReportColumnKey
  label: string
  /** The row's identity: always shown, never offered in the selector as a switch. */
  hideable: boolean
  defaultVisible: boolean
  /** Dollars. Removed entirely (not just hidden) for viewers without pay access. */
  moneyOnly: boolean
  /** Right-align the header and cells (numeric columns). */
  numeric: boolean
}

/** Table order. */
export const REPORT_COLUMNS: readonly ReportColumnDef[] = [
  { key: 'hanger', label: 'Hanger', hideable: false, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'batch', label: 'Batch', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'trimmer', label: 'Trimmer', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'outIn', label: 'Out → in', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'issued', label: 'Issued', hideable: true, defaultVisible: true, moneyOnly: false, numeric: true },
  { key: 'flower', label: 'Flower', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'trim', label: 'Trim', hideable: true, defaultVisible: false, moneyOnly: false, numeric: true },
  { key: 'stems', label: 'Stems', hideable: true, defaultVisible: false, moneyOnly: false, numeric: true },
  { key: 'variance', label: 'Variance', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'status', label: 'Status', hideable: true, defaultVisible: true, moneyOnly: false, numeric: false },
  { key: 'pay', label: 'Pay', hideable: true, defaultVisible: true, moneyOnly: true, numeric: true },
]

const BY_KEY = new Map(REPORT_COLUMNS.map((c) => [c.key, c]))

export function columnDef(key: ReportColumnKey): ReportColumnDef {
  return BY_KEY.get(key)!
}

/** Same prefix as the module's other preferences (harvest-trim-last-batch, harvest-trim-weight-unit, ...). */
export const REPORT_COLUMNS_STORE_KEY = 'harvest-trim-report-columns'

/** The columns hidden until someone turns them on. */
export function defaultHiddenColumns(): ReportColumnKey[] {
  return REPORT_COLUMNS.filter((c) => c.hideable && !c.defaultVisible).map((c) => c.key)
}

/**
 * Read the hidden set out of a stored string. Anything unusable (null, bad JSON, wrong shape, wrong types)
 * yields the default; unknown keys and the un-hideable Hanger column are dropped from an otherwise good
 * value. Never throws.
 */
export function parseStoredColumns(raw: string | null | undefined): ReportColumnKey[] {
  if (raw === null || raw === undefined || raw === '') return defaultHiddenColumns()
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return defaultHiddenColumns()
    const hidden = (v as { hidden?: unknown }).hidden
    if (!Array.isArray(hidden)) return defaultHiddenColumns()
    const keys = new Set<ReportColumnKey>()
    for (const k of hidden) {
      const def = typeof k === 'string' ? BY_KEY.get(k as ReportColumnKey) : undefined
      if (def?.hideable) keys.add(def.key)
    }
    return REPORT_COLUMNS.filter((c) => keys.has(c.key)).map((c) => c.key)
  } catch {
    return defaultHiddenColumns()
  }
}

export function serializeColumns(hidden: readonly ReportColumnKey[]): string {
  return JSON.stringify({ hidden: [...hidden] })
}

/** Columns the viewer may be offered at all: no money column without pay access. */
export function availableColumns(moneyVisible: boolean): ReportColumnDef[] {
  return REPORT_COLUMNS.filter((c) => moneyVisible || !c.moneyOnly)
}

/** What the "Columns" menu lists (Hanger included, shown as fixed). Pay is absent without pay access. */
export function selectableColumns(moneyVisible: boolean): ReportColumnDef[] {
  return availableColumns(moneyVisible)
}

/**
 * The columns to render, in table order. Hanger is always in. A hidden column is out. A money column is out
 * unless the viewer has pay access, whatever the stored preference says.
 */
export function resolveVisibleColumns(hidden: readonly ReportColumnKey[], moneyVisible: boolean): ReportColumnKey[] {
  const off = new Set(hidden)
  return availableColumns(moneyVisible)
    .filter((c) => !c.hideable || !off.has(c.key))
    .map((c) => c.key)
}

/** Flip one column. Hanger cannot be hidden, so asking to toggle it changes nothing. */
export function toggleColumn(hidden: readonly ReportColumnKey[], key: ReportColumnKey): ReportColumnKey[] {
  if (!columnDef(key).hideable) return [...hidden]
  const off = new Set(hidden)
  if (off.has(key)) off.delete(key)
  else off.add(key)
  return REPORT_COLUMNS.filter((c) => off.has(c.key)).map((c) => c.key)
}

// ─── Storage (SSR-safe, failure-tolerant; same shape as the module's other preferences) ───

export function readStoredColumns(storage?: Pick<Storage, 'getItem'> | null): ReportColumnKey[] {
  try {
    const s = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    return parseStoredColumns(s ? s.getItem(REPORT_COLUMNS_STORE_KEY) : null)
  } catch {
    // Storage disabled / denied: behave as if nothing was stored.
    return defaultHiddenColumns()
  }
}

/** Persist (or, for the default set, forget) the choice. Failure just means it won't be remembered. */
export function writeStoredColumns(hidden: readonly ReportColumnKey[], storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
  try {
    const s = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
    if (!s) return
    const isDefault =
      hidden.length === defaultHiddenColumns().length && defaultHiddenColumns().every((k) => hidden.includes(k))
    if (isDefault) s.removeItem(REPORT_COLUMNS_STORE_KEY)
    else s.setItem(REPORT_COLUMNS_STORE_KEY, serializeColumns(hidden))
  } catch {
    // The preference just won't stick.
  }
}
