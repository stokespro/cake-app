/**
 * Cash Board (v2) — read-only view model.
 *
 * PHASE 0a: this screen writes NOTHING. No mutations, no schema changes, no
 * migrations. It renders live production data so the layout can be judged
 * before any money-path code is touched.
 *
 * This file is the contract between `_actions/board.ts` (data) and
 * `page.tsx` (UI). It is a plain module, not `'use server'`, so it may
 * export types freely — `actions/finance.ts` cannot (see
 * scripts/check-server-exports.mjs).
 */

export type CashStatus = 'GO' | 'CAUTION' | 'NO_GO'

export type AgingBucket = '0-15' | '16-30' | '31+'

export type ExceptionKind =
  | 'past_due_unpaid'
  | 'stalled_partial'
  | 'paid_no_bank_trail'
  | 'money_out_no_bill'
  | 'recurring_unplanned'

// ── Hero ────────────────────────────────────────────────────────────────

export interface HeadlineBill {
  billId: string
  name: string
  vendorName: string | null
  amount: number
  dueDate: string // YYYY-MM-DD
}

// ── Panel 1: This Week's Decisions ──────────────────────────────────────

export interface DecisionBill {
  id: string
  name: string
  vendorName: string | null
  amount: number
  amountPaid: number
  remaining: number
  dueDate: string // YYYY-MM-DD
  isPastDue: boolean
}

/**
 * Bills collapsed for display only. Grouping is a UI concern — the
 * underlying per-person bills are correct and must never be merged in the
 * database (they mirror physical checks one-for-one and feed the check
 * auto-matcher, which runs at 95%).
 */
export interface DecisionGroup {
  key: string
  label: string
  vendorName: string | null
  isGroup: boolean // true when billCount > 1
  billCount: number
  total: number // sum of `remaining`
  earliestDueDate: string
  isPastDue: boolean
  bills: DecisionBill[] // always populated; length 1 when !isGroup
}

// ── Panel 2: Money Coming In ────────────────────────────────────────────

export interface ReceivableItem {
  orderId: string
  orderNumber: string
  customerName: string | null
  amount: number
  deliveredAt: string | null
  expectedDate: string | null
  daysOverdue: number // negative = not yet due
  bucket: AgingBucket | 'not_due'
}

export interface ReceivablesPanel {
  buckets: { label: AgingBucket; count: number; total: number }[]
  total: number
  notYetDue: number
  items: ReceivableItem[]
}

export interface InflowForecast {
  /** 25th-percentile weekly delivered revenue — the planning number. */
  conservativeWeekly: number
  medianWeekly: number
  /** Confirmed + packed + pending orders right now (~4 days of visibility). */
  pipelineNow: number
  weeksSampled: number
}

// ── Panel 3: Exceptions ─────────────────────────────────────────────────

export interface ExceptionItem {
  id: string
  label: string
  sublabel: string | null
  amount: number
  date: string // YYYY-MM-DD — due date, paid date, or bank date
  ageDays: number | null
}

export interface ExceptionGroup {
  kind: ExceptionKind
  title: string
  description: string
  count: number
  total: number
  items: ExceptionItem[]
}

// ── Root ────────────────────────────────────────────────────────────────

export interface CashBoardData {
  generatedAt: string // ISO
  asOfDate: string // bank as_of_date, else snapshot date
  isStale: boolean // bank data older than today in America/Chicago

  // Hero
  cashOnHand: number
  cashSource: 'bank' | 'manual'
  avgDailyOutflow: number // trailing 30d
  daysOfCashLeft: number | null // null when avgDailyOutflow <= 0
  committedThisWeek: number // remaining on unpaid/partial bills due <= end of week
  cashFloor: number // 0 in Phase 0a
  safeToPay: number // cashOnHand - committedThisWeek - cashFloor
  status: CashStatus
  headline: HeadlineBill | null

  decisionGroups: DecisionGroup[]
  receivables: ReceivablesPanel
  inflowForecast: InflowForecast
  exceptions: ExceptionGroup[]
}
