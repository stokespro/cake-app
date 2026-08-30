/**
 * Cash Board (v2) — read-only view model.
 *
 * PHASE 0a: this screen writes NOTHING. No mutations, no schema changes, no
 * migrations. It renders live production data so the layout can be judged
 * before any money-path code is touched.
 *
 * The screen answers a bill-payer's four questions, in order:
 *   1. What do I owe?                        -> WeekLedger.billsDue*
 *   2. What money do I have?                 -> WeekLedger.moneyIn (cash AND pipeline)
 *   3. Am I negative, break-even, or surplus? -> WeekLedger.verdictByTier
 *   4. So which bills get paid, and if I'm
 *      short, how do I make up the difference? -> BillTriage + Lever[]
 *
 * This file is the contract between `_actions/board.ts` (data) and
 * `page.tsx` (UI). It is a plain module, not `'use server'`, so it may
 * export types freely — `actions/finance.ts` cannot (see
 * scripts/check-server-exports.mjs).
 */

export type AgingBucket = '0-15' | '16-30' | '31+'

export type ExceptionKind =
  | 'past_due_unpaid'
  | 'stalled_partial'
  | 'paid_no_bank_trail'
  | 'money_out_no_bill'
  | 'recurring_unplanned'

/**
 * How much incoming money to count as "available."
 *   conservative — bank cash only.
 *   likely       — cash + confirmed/packed deliveries + terms payments due in
 *                  the window. Money with a name and a date on it. DEFAULT.
 *   optimistic   — also counts already-overdue receivables and unconfirmed
 *                  pending orders. Never the default: it must be a deliberate
 *                  choice, not the number that lulls you.
 */
export type AvailabilityTier = 'conservative' | 'likely' | 'optimistic'

export type Verdict = 'short' | 'break_even' | 'surplus'

export type Confidence = 'certain' | 'high' | 'medium' | 'low'

// ── Step 1 + 2: the ledger ──────────────────────────────────────────────

export interface MoneyInLine {
  key: string
  label: string
  amount: number
  confidence: Confidence
  /** Lowest tier that counts this line. */
  tier: AvailabilityTier
  /** Short plain-English caveat, e.g. "already past due — needs chasing". */
  note: string | null
}

export interface WeekLedger {
  windowStart: string // YYYY-MM-DD
  windowEnd: string // YYYY-MM-DD
  moneyIn: MoneyInLine[]
  billsDueCount: number
  billsDueTotal: number
  /** Cumulative available money at each tier. */
  availableByTier: Record<AvailabilityTier, number>
  /** available − owed, per tier. Negative = short. */
  netByTier: Record<AvailabilityTier, number>
  verdictByTier: Record<AvailabilityTier, Verdict>
  defaultTier: AvailabilityTier
}

// ── Step 4a: which bills get paid ───────────────────────────────────────

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
 * Walks bills in due-date order (oldest first, smaller first on ties) —
 * the way a stack of bills actually gets worked — marking each covered
 * until the money runs out.
 *
 * Computed for EVERY tier, because the answer genuinely differs: today it is
 * 22 / 28 / 29 bills covered at conservative / likely / optimistic. Rendering
 * one tier's triage under another tier's verdict would make the screen
 * contradict itself — the exact failure this redesign exists to remove.
 */
export interface BillTriage {
  tier: AvailabilityTier
  available: number
  covered: DecisionBill[]
  notCovered: DecisionBill[]
  coveredTotal: number
  notCoveredTotal: number
  /** available − coveredTotal. What's left after paying everything that fits. */
  leftover: number
  /** How much short on the first bill that doesn't fit. null when all fit. */
  shortfallOnNext: number | null
}

// ── Step 4b: how to make up the difference ──────────────────────────────

export interface Lever {
  key: string
  label: string
  detail: string
  amount: number
  /** Net at the default tier after applying this lever alone. */
  resultingNet: number
  /** True when this single lever takes net >= 0. */
  closesGap: boolean
}

// ── Supporting panels ───────────────────────────────────────────────────

export interface DecisionGroup {
  key: string
  label: string
  vendorName: string | null
  isGroup: boolean
  billCount: number
  total: number
  earliestDueDate: string
  isPastDue: boolean
  bills: DecisionBill[]
}

export interface ReceivableItem {
  orderId: string
  orderNumber: string
  customerName: string | null
  amount: number
  deliveredAt: string | null
  expectedDate: string | null
  daysOverdue: number
  bucket: AgingBucket | 'not_due'
}

export interface ReceivablesPanel {
  buckets: { label: AgingBucket; count: number; total: number }[]
  total: number
  notYetDue: number
  items: ReceivableItem[]
}

export interface InflowForecast {
  conservativeWeekly: number
  medianWeekly: number
  pipelineNow: number
  weeksSampled: number
}

export interface ExceptionItem {
  id: string
  label: string
  sublabel: string | null
  amount: number
  date: string
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
  generatedAt: string
  asOfDate: string
  isStale: boolean

  cashOnHand: number
  cashSource: 'bank' | 'manual'
  avgDailyOutflow: number
  /** Context only — a small line, never the headline. Burn is lumpy. */
  daysOfCashLeft: number | null

  ledger: WeekLedger
  /** Keyed by tier — see BillTriage. Index with the tier the user has selected. */
  triage: Record<AvailabilityTier, BillTriage>
  /** Keyed by tier. Empty array for any tier that is not short. */
  levers: Record<AvailabilityTier, Lever[]>

  decisionGroups: DecisionGroup[]
  receivables: ReceivablesPanel
  inflowForecast: InflowForecast
  exceptions: ExceptionGroup[]
}
