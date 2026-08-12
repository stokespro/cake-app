// SPRO-82: pure helpers for the bill-payment ledger (finance_bill_payments).
//
// No imports, no I/O — safe to import from 'use server' action files
// (actions/finance.ts, app/dashboard/finance/_actions/bank.ts) and from
// tests without a database, same shape as app/dashboard/finance/_lib/bank-prefill.ts.
//
// Three of the exports below are lockstep mirrors of SQL — keep them in sync
// EXACTLY, the same way normalizePaymentMethod() in
// app/dashboard/finance/_actions/bank.ts mirrors the SQL CASE in
// 20260728130000_assign_reconciliation_match_rpc.sql:305-309 (that file
// carries the reciprocal "Mirror normalizePaymentMethod() in bank.ts
// exactly." comment; the same pairing should exist between this file and
// each migration below):
//
//   - computeBillTotals()    mirrors public.recompute_bill_totals(p_bill_id)
//                            in 20260805210000_bill_payments_ledger.sql
//                            (spec section A3 / fn_finance_bill_payments_recompute)
//   - validatePaymentInput() mirrors fn_finance_bill_payments_guard_overpay()'s
//                            overpay/void checks in
//                            20260805210000_bill_payments_ledger.sql (spec
//                            section A2), plus the same field rules
//                            actions/finance.ts has always enforced in TS
//                            (method required, check needs a ref, amount > 0).
//   - selectPaymentToLink()  mirrors the payment-selection query in
//                            assign_reconciliation_match() in
//                            supabase/migrations/20260806220000_recon_link_payments.sql
//                            (spec section A2) — "link an existing unlinked
//                            payment vs. create a new one" for reconciliation.
//
// The DB is always the authority (the overpay guard runs inside a
// row-locked transaction so it is race-proof; this module is not) — these
// functions exist so the UI can validate/preview without a round trip, and
// so the logic is unit-testable without Supabase.

/** Payment methods accepted by finance_bills.payment_method / finance_bill_payments.payment_method. */
export const VALID_PAYMENT_METHODS = ['card', 'ach', 'check', 'cash'] as const
export type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number]

export type BillStatus = 'unpaid' | 'paid' | 'partial' | 'void'

/**
 * Error codes surfaced by the bill-payment actions. 'would_overpay' and
 * 'bill_void' are detected by pattern-matching the DB's 'BILL_OVERPAY:' /
 * 'BILL_VOID:' message prefixes (spec section A2) as well as being raised
 * directly by validatePaymentInput() below for the same conditions.
 */
export type PaymentErrorCode = 'would_overpay' | 'bill_void' | 'validation' | 'not_found'

/** Message prefixes fn_finance_bill_payments_guard_overpay() raises with (spec A2). */
export const BILL_OVERPAY_PREFIX = 'BILL_OVERPAY:'
export const BILL_VOID_PREFIX = 'BILL_VOID:'

/**
 * Maps a Postgres error message to a PaymentErrorCode by its 'BILL_OVERPAY:' /
 * 'BILL_VOID:' prefix (spec A2). Returns undefined for any other error —
 * callers should fall back to a generic error in that case.
 */
export function mapPaymentDbErrorCode(message: string): PaymentErrorCode | undefined {
  if (message.startsWith(BILL_OVERPAY_PREFIX)) return 'would_overpay'
  if (message.startsWith(BILL_VOID_PREFIX)) return 'bill_void'
  return undefined
}

/**
 * Strips the `BILL_OVERPAY:` / `BILL_VOID:` sentinel prefix from a payment
 * error message before it reaches a user's screen. Those prefixes exist
 * purely so mapPaymentDbErrorCode() (and validatePaymentInput()'s own
 * hard-coded checks) can classify the error into a PaymentErrorCode — the
 * caller gets that classification via `errorCode`, so the raw sentinel text
 * itself must never leak into a user-facing `error` string. Every action
 * boundary in actions/finance.ts and app/dashboard/finance/_actions/bank.ts
 * that returns one of these messages must run it through this function
 * first (see those files for the call sites).
 *
 * A message with no recognized prefix is returned completely unchanged
 * (not even trimmed) — this must be a no-op for ordinary error text.
 */
export function stripPaymentErrorPrefix(message: string): string {
  if (message.startsWith(BILL_OVERPAY_PREFIX)) {
    return message.slice(BILL_OVERPAY_PREFIX.length).trimStart()
  }
  if (message.startsWith(BILL_VOID_PREFIX)) {
    return message.slice(BILL_VOID_PREFIX.length).trimStart()
  }
  return message
}

/**
 * Converts a dollar amount to integer cents via rounding. Every amount this
 * module handles is NUMERIC(12,2) in Postgres — always cent-quantized — so
 * summing/comparing in integer cents rather than raw JS floats sidesteps
 * IEEE-754 representation error entirely (0.1 + 0.2 !== 0.3 in JS, but
 * 10 + 20 === 30). Same technique, same rationale, as amountsMatch() in
 * app/dashboard/finance/_lib/bank-prefill.ts:192-195 — that one tolerates a
 * penny of drift because it's comparing two independently-rounded sources
 * (bank vs. bill); this one has no tolerance because NUMERIC arithmetic in
 * Postgres is exact and this function must match it exactly, not just
 * approximately.
 */
function toCents(amount: number): number {
  return Math.round(amount * 100)
}

/** The shape of a finance_bill_payments row needed to compute derived bill totals. */
export interface PaymentForTotals {
  amount: number
  paid_date: string
  payment_method: PaymentMethod
  payment_ref: string | null
  created_at: string
}

export interface BillTotals {
  amountPaid: number
  status: BillStatus
  remaining: number
  latestPayment: PaymentForTotals | null
}

/**
 * Mirrors public.recompute_bill_totals(p_bill_id UUID) in
 * supabase/migrations/20260805210000_bill_payments_ledger.sql EXACTLY
 * (spec section A3):
 *
 *   total  := COALESCE(SUM(amount), 0) FROM finance_bill_payments WHERE bill_id = p_bill_id
 *   latest := the row with MAX(paid_date), tie-broken by MAX(created_at)
 *   IF bill.status = 'void' THEN RETURN; END IF;   -- never touch voided bills
 *   status := total<=0 ? 'unpaid' : total>=bill.amount ? 'paid' : 'partial'
 *   paid_date / payment_method / payment_ref := NULL when total<=0, else latest's
 *
 * `currentStatus` mirrors the trigger's own void short-circuit: pass the
 * bill's CURRENT status (before this recompute) and a void bill returns
 * `null` — meaning "the derived columns are untouched", not "$0 paid". A
 * void bill's amount_paid/status/etc. are frozen at whatever they were
 * before voiding (the overpay guard, spec A2, also blocks new payments
 * against a void bill, so nothing can drift while it stays void).
 *
 * `amount` is NUMERIC in Postgres — exact decimal, no float epsilon. This
 * function sums and compares in integer cents (see toCents() above), which
 * exactly mirrors Postgres NUMERIC(12,2) arithmetic for the cent-quantized
 * values this app stores — plain float addition would not: e.g. a $0.07
 * bill paid by $0.01 + $0.06 sums to 0.06999999999999999 in raw JS floats,
 * which is LESS than 0.07 and would wrongly compute 'partial' instead of
 * 'paid' for a bill the SQL (exact NUMERIC) correctly closes out.
 */
export function computeBillTotals(
  billAmount: number,
  payments: PaymentForTotals[],
  currentStatus?: BillStatus
): BillTotals | null {
  if (currentStatus === 'void') return null

  const amountPaidCents = payments.reduce((sum, p) => sum + toCents(p.amount), 0)
  const amountPaid = amountPaidCents / 100
  const billAmountCents = toCents(billAmount)

  let latestPayment: PaymentForTotals | null = null
  for (const payment of payments) {
    if (!latestPayment) {
      latestPayment = payment
      continue
    }
    const isLater =
      payment.paid_date > latestPayment.paid_date ||
      (payment.paid_date === latestPayment.paid_date && payment.created_at > latestPayment.created_at)
    if (isLater) latestPayment = payment
  }

  const status: BillStatus =
    amountPaidCents <= 0 ? 'unpaid' : amountPaidCents >= billAmountCents ? 'paid' : 'partial'

  return {
    amountPaid,
    status,
    remaining: (billAmountCents - amountPaidCents) / 100,
    // Mirrors "paid_date = CASE WHEN total <= 0 THEN NULL ELSE latest.paid_date END" et al —
    // when there is no positive total there is nothing to report as "latest".
    latestPayment: amountPaidCents <= 0 ? null : latestPayment,
  }
}

/** The subset of a finance_bill_payments row needed to derive bank_confirmed. */
export interface CheckPaymentForConfirmation {
  bill_id: string
  bank_bs_id: number | null
}

/**
 * FIX 3 (SPRO-82 adversarial review): `finance_bills.bank_confirmed` — as
 * consumed by lib/finance/cash-flow.ts's `isUnclearedCheck` check
 * (`payment_method === 'check' && !bank_confirmed`) — must be derived from
 * the PAYMENT ledger now, not from `finance_reconciliation_log` rows keyed
 * to the whole bill. A bill can hold several check payments; the old
 * bill-scoped `confirmedBillIds` set went true the moment ANY reconciliation
 * log row existed for the bill, so a second, still-uncleared check payment
 * on an otherwise-cleared bill silently dropped out of the cash-flow /
 * weekly-budget outflow projection even though real money hadn't cleared
 * the bank yet.
 *
 * Computes `bank_confirmed` PER BILL from ONLY its check payments: a bill id
 * is included in the returned set only when it has at least one check
 * payment AND every one of them has a non-null `bank_bs_id`. A bill with
 * zero check payments is never added to the set — actions/finance.ts's
 * getMonthSummary()/getWeeklyBudget() only query `payment_method = 'check'`
 * rows in the first place, so this keeps "finance_bills with zero payments"
 * behaving exactly as it did before this fix (bank_confirmed defaults to
 * false there either way, and cash-flow.ts's isUnclearedCheck only reads it
 * when payment_method === 'check').
 *
 * Deliberately conservative: a bill with even one uncleared check payment is
 * excluded from the set, so the WHOLE bill re-enters the outflow projection
 * (not just the uncleared portion). That errs toward showing MORE upcoming
 * outflow than strictly necessary, which is the safe direction for cash
 * planning — silently under-counting outflow (the pre-fix bug) is the
 * dangerous direction.
 */
export function deriveBankConfirmedBillIds(payments: CheckPaymentForConfirmation[]): Set<string> {
  const allConfirmedSoFar = new Map<string, boolean>()

  for (const payment of payments) {
    const confirmed = payment.bank_bs_id != null
    const prev = allConfirmedSoFar.get(payment.bill_id)
    allConfirmedSoFar.set(payment.bill_id, prev === undefined ? confirmed : prev && confirmed)
  }

  const result = new Set<string>()
  for (const [billId, allConfirmed] of allConfirmedSoFar) {
    if (allConfirmed) result.add(billId)
  }
  return result
}

/** Candidate payment fields being validated — what a create/edit form submits. */
export interface PaymentInputCandidate {
  amount: number
  payment_method: string | null | undefined
  payment_ref?: string | null
}

/** Context needed to evaluate the overpay guard against a specific bill. */
export interface PaymentValidationContext {
  billAmount: number
  billStatus: BillStatus
  /**
   * Sum of every OTHER payment already recorded against this bill (i.e.
   * excluding the one being edited, if any). For a brand-new payment this is
   * simply the bill's current `amount_paid` (itself already the
   * trigger-maintained sum of all existing payments).
   */
  existingPaymentsTotal: number
}

export type PaymentValidationResult =
  | { valid: true }
  | { valid: false; error: string; errorCode: PaymentErrorCode }

/**
 * Validates a candidate payment before it is sent to the DB. Mirrors:
 *   - the field rules actions/finance.ts's validatePaymentFields() has always
 *     enforced (method required and in VALID_PAYMENT_METHODS, check requires
 *     a non-blank payment_ref, amount > 0), and
 *   - fn_finance_bill_payments_guard_overpay() in
 *     supabase/migrations/20260805210000_bill_payments_ledger.sql (spec A2):
 *     a void bill is refused with the 'BILL_VOID:' prefix, and a payment that
 *     would push the bill's total past its amount is refused with the
 *     'BILL_OVERPAY:' prefix — matched here so the TS and SQL messages read
 *     the same way to the user regardless of which layer catches it first.
 *
 * This is a pre-check for UX only — the DB guard (row-locked, so race-proof
 * against concurrent inserts) is the actual authority. A caller must still
 * handle a 'BILL_OVERPAY:' / 'BILL_VOID:' error coming back from the insert
 * itself (see mapPaymentDbErrorCode()).
 */
export function validatePaymentInput(
  input: PaymentInputCandidate,
  context: PaymentValidationContext
): PaymentValidationResult {
  if (context.billStatus === 'void') {
    return {
      valid: false,
      errorCode: 'bill_void',
      // Wording matches fn_finance_bill_payments_guard_overpay()'s own
      // BILL_VOID: message exactly (spec A2) — see this file's header.
      error: `${BILL_VOID_PREFIX} Cannot record a payment against a voided bill. Un-void the bill first.`,
    }
  }

  const method = input.payment_method?.trim() || null
  if (!method || !(VALID_PAYMENT_METHODS as readonly string[]).includes(method)) {
    return {
      valid: false,
      errorCode: 'validation',
      error: 'Payment method is required. Choose card, ach, check, or cash.',
    }
  }
  if (method === 'check' && !input.payment_ref?.trim()) {
    return {
      valid: false,
      errorCode: 'validation',
      error: 'Check number is required when payment method is check.',
    }
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return {
      valid: false,
      errorCode: 'validation',
      error: 'Payment amount must be greater than 0.',
    }
  }

  // Compared in integer cents (see toCents()'s doc comment above
  // computeBillTotals) so this pre-check never disagrees with the DB
  // guard's exact NUMERIC arithmetic over a plain-float rounding artifact.
  const totalCents = toCents(context.existingPaymentsTotal) + toCents(input.amount)
  const billAmountCents = toCents(context.billAmount)
  if (totalCents > billAmountCents) {
    const total = totalCents / 100
    return {
      valid: false,
      errorCode: 'would_overpay',
      // Wording matches fn_finance_bill_payments_guard_overpay()'s own
      // BILL_OVERPAY: message exactly (spec A2) — see this file's header.
      error:
        `${BILL_OVERPAY_PREFIX} Payments would total ${total.toFixed(2)}, exceeding the bill amount ` +
        `of ${context.billAmount.toFixed(2)}. Edit the bill amount first, or reduce this payment.`,
    }
  }

  return { valid: true }
}

/** The subset of a finance_bill_payments row needed to pick a link candidate. */
export interface PaymentForLink {
  amount: number
  paid_date: string
  created_at: string
}

export type SelectPaymentToLinkResult<T extends PaymentForLink = PaymentForLink> =
  | { action: 'link'; payment: T }
  | { action: 'mismatch'; payment: T }
  | { action: 'create' }

/**
 * Mirrors the payment-selection query in `assign_reconciliation_match()`,
 * supabase/migrations/20260806220000_recon_link_payments.sql (spec section
 * A2), EXACTLY:
 *
 *   SELECT * INTO v_payment
 *   FROM public.finance_bill_payments
 *   WHERE bill_id = p_target_bill_id AND bank_bs_id IS NULL
 *   ORDER BY ABS(amount - v_bank_amount), paid_date, created_at
 *   LIMIT 1
 *
 *   IF FOUND THEN
 *     IF ABS(v_payment.amount - v_bank_amount) <= 0.01 THEN link ELSE mismatch
 *   ELSE
 *     create
 *
 * `unlinkedPayments` must already be filtered to the target bill's payments
 * with `bank_bs_id === null` — this function does not know about bill ids or
 * bank_bs_id, it only picks among whatever list it's handed, exactly as the
 * SQL's WHERE clause does before the ORDER BY runs.
 *
 * No unlinked payments at all means the bill has no money recorded for this
 * transaction yet, so the bank line itself becomes a new payment ('create') —
 * that INSERT is where the SQL's overpay guard applies; this function never
 * blocks a create.
 *
 * Otherwise the closest-amount payment wins (not the oldest — see the SQL's
 * "Note the ordering choice" comment, spec A2), tie-broken by `paid_date`
 * then `created_at`, both ascending (oldest first), matching
 * `ORDER BY ABS(amount - v_bank_amount), paid_date, created_at`. If that
 * closest payment is within $0.01 of the bank amount it's a 'link' (no money
 * moves, only `bank_bs_id` is set); otherwise it's a genuine 'mismatch' and
 * the caller must refuse rather than silently create a second payment
 * (locked decision #2, spec).
 *
 * Compared in integer cents via toCents() (see its doc comment above
 * computeBillTotals) for the same reason as everywhere else in this file:
 * plain float subtraction can misjudge a boundary that Postgres NUMERIC
 * arithmetic gets exactly right.
 */
export function selectPaymentToLink<T extends PaymentForLink>(
  bankAmount: number,
  unlinkedPayments: T[]
): SelectPaymentToLinkResult<T> {
  if (unlinkedPayments.length === 0) return { action: 'create' }

  const bankCents = toCents(bankAmount)

  let closest = unlinkedPayments[0]
  let closestDiffCents = Math.abs(toCents(closest.amount) - bankCents)

  for (let i = 1; i < unlinkedPayments.length; i++) {
    const candidate = unlinkedPayments[i]
    const diffCents = Math.abs(toCents(candidate.amount) - bankCents)
    const isCloser =
      diffCents < closestDiffCents ||
      (diffCents === closestDiffCents &&
        (candidate.paid_date < closest.paid_date ||
          (candidate.paid_date === closest.paid_date && candidate.created_at < closest.created_at)))
    if (isCloser) {
      closest = candidate
      closestDiffCents = diffCents
    }
  }

  return closestDiffCents <= 1 // <= $0.01, in cents
    ? { action: 'link', payment: closest }
    : { action: 'mismatch', payment: closest }
}
