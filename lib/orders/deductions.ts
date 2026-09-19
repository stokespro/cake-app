// SPRO-148: pure helpers for order-level flat-dollar discounts and credits.
//
// No imports, no I/O, no browser or Node globals — safe to import from
// 'use server' action files (actions/orders.ts), from client components
// ('use client' pages and sheets) and from tests without a database. Same
// shape as lib/finance/bill-payments.ts.
//
// The pair rule below is a lockstep mirror of the two CHECK constraints in
// supabase/migrations/20260918120000_add_order_discounts_credits.sql
// (orders_discount_pair_check / orders_credit_pair_check) — keep the two in
// sync EXACTLY. The DB is always the authority; these functions exist so the
// UI can validate and preview without a round trip, and so the server can
// recompute the net total without ever trusting a client-supplied total.
//
// One rule here is deliberately STRICTER than the SQL: amounts are money and
// are persisted rounded to whole cents, so a sub-cent amount is rejected up
// front rather than stored as 0.00 and bounced by the `amount > 0` CHECK
// mid-write. See validateDeduction().

/** Max length of a trimmed discount/credit reason — mirrors the CHECK constraints. */
export const MAX_DEDUCTION_REASON_LENGTH = 255

/** The two order-level deduction kinds. Exactly one of each is allowed per order. */
export type DeductionKind = 'discount' | 'credit'

/** The four persisted columns, in their normalized (both-null or both-set) form. */
export interface OrderDeductionFields {
  discount_amount: number | null
  discount_reason: string | null
  credit_amount: number | null
  credit_reason: string | null
}

/** Raw amount/reason as they arrive from a form or a server-action payload. */
export interface DeductionInput {
  amount?: number | string | null
  reason?: string | null
}

/** A single normalized deduction — both fields null, or both set. */
export interface NormalizedDeduction {
  amount: number | null
  reason: string | null
}

/** Line item shape needed to compute the active subtotal. */
export interface DeductionLineItem {
  line_total?: number | null
  _deleted?: boolean
}

/** The money breakdown shown under totals and persisted as total_price. */
export interface OrderTotalsBreakdown {
  /** Sum of active line-item totals, before deductions. */
  subtotal: number
  discount: number
  credit: number
  /** discount + credit. */
  deductions: number
  /** subtotal - deductions. Never negative once validation has passed. */
  netTotal: number
}

export type DeductionValidation =
  | { ok: true; fields: OrderDeductionFields; totals: OrderTotalsBreakdown }
  | { ok: false; error: string }

const LABELS: Record<DeductionKind, string> = {
  discount: 'Discount',
  credit: 'Credit',
}

/** Rounds to whole cents, avoiding the float drift of repeated subtraction. */
export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Sum of line totals for items that are not marked deleted. Non-finite and
 * missing line totals count as 0 — the same defensive treatment the write
 * paths in actions/orders.ts have always applied to line_total.
 */
export function calculateItemSubtotal(items: readonly DeductionLineItem[] | null | undefined): number {
  const sum = (items ?? [])
    .filter(item => !item._deleted)
    .reduce((acc, item) => {
      const value = item.line_total
      return acc + (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    }, 0)
  return roundCurrency(sum)
}

/**
 * Normalizes one raw amount/reason pair.
 *
 * An empty string, null or undefined amount means "absent"; a blank or
 * whitespace-only reason means "absent". A non-numeric amount is preserved as
 * NaN so validateDeduction() can reject it rather than silently coercing it
 * to 0 — silent coercion is how a typo'd discount would become a free order.
 */
export function normalizeDeduction(input: DeductionInput | null | undefined): NormalizedDeduction {
  const rawAmount = input?.amount
  let amount: number | null
  if (rawAmount === null || rawAmount === undefined || (typeof rawAmount === 'string' && rawAmount.trim() === '')) {
    amount = null
  } else {
    amount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount)
  }

  const trimmedReason = typeof input?.reason === 'string' ? input.reason.trim() : ''
  const reason = trimmedReason === '' ? null : trimmedReason

  return { amount, reason }
}

/**
 * Validates one normalized pair. Returns an error message, or null when the
 * pair is valid (either fully absent or fully present and in range).
 *
 * Cent policy (SPRO-148 reviewer fix): amounts are money, and every write path
 * persists `roundCurrency(amount)`, so the value VALIDATED here is the
 * normalized one — not the raw input. Without that, $0.001 passes `> 0`, is
 * stored as 0.00 and only the DB CHECK stops it, surfacing as a generic
 * "Failed to create order". Anything that does not round up to at least one
 * cent is rejected here, before any write.
 */
export function validateDeduction(kind: DeductionKind, value: NormalizedDeduction): string | null {
  const label = LABELS[kind]
  const { amount, reason } = value

  if (amount === null && reason === null) return null

  if (amount === null) return `${label} amount is required when a ${kind} reason is entered.`
  if (reason === null) return `${label} reason is required.`

  if (!Number.isFinite(amount)) return `${label} amount must be a valid number.`
  if (amount <= 0) return `${label} amount must be greater than zero.`
  // Sub-cent amounts: positive as typed, but 0.00 once normalized for storage.
  if (roundCurrency(amount) <= 0) return `${label} amount must be at least $0.01.`
  if (reason.length > MAX_DEDUCTION_REASON_LENGTH) {
    return `${label} reason must be ${MAX_DEDUCTION_REASON_LENGTH} characters or less.`
  }

  return null
}

/**
 * Computes the money breakdown for an already-validated set of fields.
 * Callers that have not validated should use validateOrderDeductions().
 */
export function calculateOrderTotals(subtotal: number, fields: OrderDeductionFields): OrderTotalsBreakdown {
  const safeSubtotal = roundCurrency(Number.isFinite(subtotal) ? subtotal : 0)
  const discount = roundCurrency(fields.discount_amount ?? 0)
  const credit = roundCurrency(fields.credit_amount ?? 0)
  const deductions = roundCurrency(discount + credit)

  return {
    subtotal: safeSubtotal,
    discount,
    credit,
    deductions,
    netTotal: roundCurrency(safeSubtotal - deductions),
  }
}

/**
 * The single entry point used by every write path and by the client forms:
 * normalize both pairs, reject anything the DB constraints would reject plus
 * the cross-field rule the DB cannot express (combined deductions may not
 * exceed the active item subtotal), and hand back the exact column values to
 * persist alongside the server-computed net total.
 *
 * A discount and a credit may coexist; together they may bring the net total
 * down to exactly zero but never below it.
 */
export function validateOrderDeductions(params: {
  subtotal: number
  discount?: DeductionInput | null
  credit?: DeductionInput | null
}): DeductionValidation {
  const { subtotal } = params

  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return { ok: false, error: 'Order subtotal must be a valid, non-negative number.' }
  }

  const discount = normalizeDeduction(params.discount)
  const credit = normalizeDeduction(params.credit)

  const discountError = validateDeduction('discount', discount)
  if (discountError) return { ok: false, error: discountError }

  const creditError = validateDeduction('credit', credit)
  if (creditError) return { ok: false, error: creditError }

  const fields: OrderDeductionFields = {
    discount_amount: discount.amount === null ? null : roundCurrency(discount.amount),
    discount_reason: discount.reason,
    credit_amount: credit.amount === null ? null : roundCurrency(credit.amount),
    credit_reason: credit.reason,
  }

  const totals = calculateOrderTotals(subtotal, fields)

  if (totals.deductions > totals.subtotal) {
    return {
      ok: false,
      error:
        `Discount and credit together ($${totals.deductions.toFixed(2)}) cannot exceed ` +
        `the order subtotal of $${totals.subtotal.toFixed(2)}.`,
    }
  }

  return { ok: true, fields, totals }
}

/** True when an order carries either deduction — the gate for showing the breakdown. */
export function hasOrderDeductions(
  order: Partial<OrderDeductionFields> | null | undefined
): boolean {
  if (!order) return false
  const discount = order.discount_amount
  const credit = order.credit_amount
  return (typeof discount === 'number' && discount > 0) || (typeof credit === 'number' && credit > 0)
}

/**
 * Breakdown for a persisted order. `total_price` is already net, so the
 * subtotal is reconstructed by adding the deductions back — this keeps detail
 * views consistent with what the server stored even if a line item was later
 * edited without re-saving the order header.
 */
export function breakdownFromOrder(order: {
  total_price?: number | null
  discount_amount?: number | null
  credit_amount?: number | null
}): OrderTotalsBreakdown {
  const netTotal = roundCurrency(order.total_price ?? 0)
  const discount = roundCurrency(order.discount_amount ?? 0)
  const credit = roundCurrency(order.credit_amount ?? 0)
  const deductions = roundCurrency(discount + credit)

  return {
    subtotal: roundCurrency(netTotal + deductions),
    discount,
    credit,
    deductions,
    netTotal,
  }
}

/**
 * Revenue for an order in the finance engines: the active line-item subtotal
 * less the persisted deductions. Legacy header-only orders (zero line items)
 * keep the total_price fallback, which is what preserves the historical
 * header-only revenue the finance rollups depend on.
 */
export function orderRevenueFromItems(order: {
  total_price?: number | null
  discount_amount?: number | null
  credit_amount?: number | null
  order_items?: readonly DeductionLineItem[] | null
}): number {
  const items = order.order_items ?? []
  if (items.length === 0) return roundCurrency(order.total_price ?? 0)

  const subtotal = calculateItemSubtotal(items)
  const deductions = roundCurrency(roundCurrency(order.discount_amount ?? 0) + roundCurrency(order.credit_amount ?? 0))
  return roundCurrency(subtotal - deductions)
}
