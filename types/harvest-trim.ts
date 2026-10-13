// Domain types for the Harvest & Trim module.
//
// IMPORTANT: plain `export type` / `export interface` declarations ONLY. Never
// `export type { X }` or a bare `export { X }`: this file is imported by
// 'use server' action files, and scripts/check-server-exports.mjs (run during
// `npm run build`) fails the build on re-export syntax in those files — see
// the SPRO-82 outage. Runtime constants (role arrays, status lists) live in
// lib/trim/*, not here.
//
// Row interfaces mirror the DB columns (snake_case), like types/cultivation.ts.
// Numeric columns arrive from Supabase as numbers or numeric strings
// depending on the path, so weight/money fields are typed `number`; coerce
// with Number() at the query boundary.

// ─── Enumerations ────────────────────────────────────────────────────────────

/** hanger_loads.status. `partial` = unfinished return, plants still on the hanger. */
export type HangerLoadStatus =
  | 'hung'
  | 'dried'
  | 'checked_out'
  | 'partial'
  | 'returned'
  | 'reconciled'
  | 'void'

export type HangerStatus = 'active' | 'retired' | 'lost'
export type LoadSource = 'harvest' | 'trim_station'

/** trim_checkouts.status — one custody episode. */
export type CheckoutStatus = 'out' | 'returned' | 'released'
export type ReturnKind = 'complete' | 'unfinished'
export type VarianceStatus = 'ok' | 'flagged' | 'accepted'

/** trim_pay_entries.status: open -> ready (batch closed) -> approved (payout + bill). */
export type PayEntryStatus = 'open' | 'ready' | 'approved'
export type PayoutStatus = 'approved' | 'reversed'

export type WeightUnit = 'g' | 'lb'

/** What the station should do next with a scanned hanger (resolveScan hint). */
export type ScanNextStep =
  | 'new_load'
  | 'record_dry'
  | 'checkout'
  | 'checkin'
  | 'reissue'
  | 'resolve_variance'
  | 'closed_out'
  | 'inactive'

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface TrimSettings {
  variance_pct_threshold: number
  variance_floor_g: number
  updated_by: string | null
  updated_at: string
}

export interface TrimStaff {
  id: string
  full_name: string
  display_name: string | null
  phone: string | null
  email: string | null
  start_date: string | null
  pay_per_lb: number
  vendor_id: string | null
  is_active: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Hanger {
  id: string
  code: string
  label_seq: number
  status: HangerStatus
  notes: string | null
  created_at: string
  updated_at: string
}

export interface HangerLoad {
  id: string
  hanger_id: string
  batch_id: string
  status: HangerLoadStatus
  source: LoadSource
  plant_count: number | null
  wet_g: number | null
  wet_recorded_at: string | null
  dry_g: number | null
  dry_recorded_at: string | null
  remaining_g: number | null
  remaining_plant_count: number | null
  reconciled_at: string | null
  voided_at: string | null
  void_reason: string | null
  created_at: string
  updated_at: string
}

export interface TrimCheckout {
  id: string
  load_id: string
  seq: number
  trimmer_id: string
  trimmer_name: string
  status: CheckoutStatus
  issued_g: number
  issued_plant_count: number | null
  rate_per_lb_applied: number
  checked_out_at: string
  returned_at: string | null
  return_kind: ReturnKind | null
  flower_g: number | null
  trim_g: number | null
  stems_g: number | null
  remaining_g: number | null
  remaining_plant_count: number | null
  /** Generated columns — never written from TS. */
  plants_finished: number | null
  processed_g: number | null
  returned_total_g: number | null
  variance_g: number | null
  variance_pct: number | null
  flag_pct_applied: number | null
  flag_floor_g_applied: number | null
  variance_status: VarianceStatus | null
  variance_reason: string | null
}

export interface TrimPayEntry {
  id: string
  checkout_id: string
  batch_id: string
  trimmer_id: string
  flower_g: number
  rate_per_lb_applied: number
  amount: number
  status: PayEntryStatus
  payout_id: string | null
}

export interface TrimPayout {
  id: string
  batch_id: string
  trimmer_id: string
  vendor_id: string
  flower_g: number
  amount: number
  due_date: string
  bill_id: string | null
  status: PayoutStatus
  approved_by: string
  approved_at: string
}

export interface TrimEvent {
  id: number
  occurred_at: string
  actor_user_id: string | null
  event_type: string
  hanger_id: string | null
  load_id: string | null
  checkout_id: string | null
  batch_id: string | null
  payload: Record<string, unknown>
}

// ─── Action contract ─────────────────────────────────────────────────────────

export type ActionErrorCode =
  | 'STATE'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'FORBIDDEN'
  | 'DUPLICATE_OPEN'
  | 'ALREADY_OUT'
  | 'BATCH_REQUIRED'
  | 'DUPLICATE_NAME'

/** One return shape for every harvest-trim action, reads included. */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: ActionErrorCode }
