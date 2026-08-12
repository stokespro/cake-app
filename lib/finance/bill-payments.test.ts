// SPRO-82: coverage for the pure helpers behind the finance_bill_payments
// ledger. Every expectation here is derived directly from the SQL in
// supabase/migrations/20260805210000_bill_payments_ledger.sql — the point of
// this file is to keep computeBillTotals()/validatePaymentInput() and
// recompute_bill_totals()/fn_finance_bill_payments_guard_overpay() in
// lockstep, so a case is called out with "SQL:" in its title or a comment
// whenever it exists specifically because the SQL does something
// non-obvious. Follows the house style of
// app/dashboard/finance/_lib/bank-prefill.test.ts.

import { describe, expect, it } from 'vitest';
import {
  BILL_OVERPAY_PREFIX,
  BILL_VOID_PREFIX,
  computeBillTotals,
  deriveBankConfirmedBillIds,
  mapPaymentDbErrorCode,
  selectPaymentToLink,
  stripPaymentErrorPrefix,
  validatePaymentInput,
  type CheckPaymentForConfirmation,
  type PaymentForLink,
  type PaymentForTotals,
} from './bill-payments';

// Minimal payment factory — every field computeBillTotals() actually reads.
const payment = (
  amount: number,
  paid_date: string,
  created_at: string,
  overrides: Partial<PaymentForTotals> = {}
): PaymentForTotals => ({
  amount,
  paid_date,
  created_at,
  payment_method: 'ach',
  payment_ref: null,
  ...overrides,
});

describe('computeBillTotals', () => {
  it('returns unpaid with a zero amountPaid and no latestPayment for no payments', () => {
    // SQL: total := COALESCE(SUM(amount), 0) FROM ... WHERE bill_id = p_bill_id
    // — an empty set sums to 0 via COALESCE, same as reduce()'s 0 initial value.
    expect(computeBillTotals(100, [])).toEqual({
      amountPaid: 0,
      status: 'unpaid',
      remaining: 100,
      latestPayment: null,
    });
  });

  it('is partial for one payment less than the bill amount', () => {
    const p = payment(40, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(computeBillTotals(100, [p])).toEqual({
      amountPaid: 40,
      status: 'partial',
      remaining: 60,
      latestPayment: p,
    });
  });

  it('is partial for two payments summing below the bill amount', () => {
    const p1 = payment(30, '2026-08-01', '2026-08-01T10:00:00Z');
    const p2 = payment(20, '2026-08-05', '2026-08-05T10:00:00Z');
    const result = computeBillTotals(100, [p1, p2]);
    expect(result?.amountPaid).toBe(50);
    expect(result?.status).toBe('partial');
    expect(result?.remaining).toBe(50);
    expect(result?.latestPayment).toBe(p2); // later paid_date wins
  });

  it('is paid when payments sum to exactly the bill amount', () => {
    // SQL: status := ... WHEN v_total >= v_bill.amount THEN 'paid' — >=, not >.
    const p1 = payment(60, '2026-08-01', '2026-08-01T10:00:00Z');
    const p2 = payment(40, '2026-08-05', '2026-08-05T10:00:00Z');
    const result = computeBillTotals(100, [p1, p2]);
    expect(result?.amountPaid).toBe(100);
    expect(result?.status).toBe('paid');
    expect(result?.remaining).toBe(0);
  });

  it('is paid for a single payment equal to the full bill amount', () => {
    const p = payment(250.5, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(computeBillTotals(250.5, [p])).toEqual({
      amountPaid: 250.5,
      status: 'paid',
      remaining: 0,
      latestPayment: p,
    });
  });

  it('returns null for a void bill — NOT a zeroed object', () => {
    // SQL: IF v_bill.status = 'void' THEN RETURN; END IF; — an early RETURN
    // with no result row, i.e. "the derived columns are untouched", which
    // this mirrors as null rather than as { amountPaid: 0, status: 'void', ... }.
    // Passing currentStatus is required to trigger this — computeBillTotals()
    // cannot infer voidness from the payments array alone.
    const p = payment(50, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(computeBillTotals(100, [p], 'void')).toBeNull();
  });

  it('breaks a latest-payment tie on equal paid_date by MAX(created_at)', () => {
    // SQL: ORDER BY paid_date DESC, created_at DESC LIMIT 1
    const earlierCreated = payment(30, '2026-08-01', '2026-08-01T09:00:00Z', {
      payment_method: 'card',
    });
    const laterCreated = payment(20, '2026-08-01', '2026-08-01T15:00:00Z', {
      payment_method: 'cash',
    });
    // Order in the array must not matter — the comparison, not array order,
    // decides the winner.
    expect(computeBillTotals(100, [earlierCreated, laterCreated])?.latestPayment).toBe(laterCreated);
    expect(computeBillTotals(100, [laterCreated, earlierCreated])?.latestPayment).toBe(laterCreated);
  });

  it('does not drift on float-fragile cent sums (0.01 + 0.06 must equal 0.07, not fall short)', () => {
    // Raw IEEE-754 addition: 0.01 + 0.06 === 0.06999999999999999, which is
    // LESS than 0.07 — a naive `total >= bill.amount` in JS would wrongly
    // read this bill as still 'partial' even though Postgres NUMERIC(12,2)
    // (exact) closes it out as 'paid'. This is exactly the case the cents-
    // integer arithmetic in bill-payments.ts exists to prevent drifting on.
    const p1 = payment(0.01, '2026-08-01', '2026-08-01T10:00:00Z');
    const p2 = payment(0.06, '2026-08-02', '2026-08-02T10:00:00Z');
    const result = computeBillTotals(0.07, [p1, p2]);
    expect(result?.amountPaid).toBe(0.07);
    expect(result?.status).toBe('paid');
    expect(result?.remaining).toBe(0);
  });

  it('does not drift on the classic 0.1 + 0.2 floating-point case', () => {
    const p1 = payment(0.1, '2026-08-01', '2026-08-01T10:00:00Z');
    const p2 = payment(0.2, '2026-08-02', '2026-08-02T10:00:00Z');
    const result = computeBillTotals(0.3, [p1, p2]);
    expect(result?.amountPaid).toBe(0.3);
    expect(result?.status).toBe('paid');
    expect(result?.remaining).toBe(0);
  });

  it('does not drift on a realistic bill split into two payments (100.80 = 50.40 + 50.40)', () => {
    const p1 = payment(50.4, '2026-08-01', '2026-08-01T10:00:00Z');
    const p2 = payment(50.4, '2026-08-15', '2026-08-15T10:00:00Z');
    const result = computeBillTotals(100.8, [p1, p2]);
    expect(result?.amountPaid).toBe(100.8);
    expect(result?.status).toBe('paid');
    expect(result?.remaining).toBe(0);
  });
});

describe('validatePaymentInput', () => {
  const context = (overrides: Partial<Parameters<typeof validatePaymentInput>[1]> = {}) => ({
    billAmount: 100,
    billStatus: 'unpaid' as const,
    existingPaymentsTotal: 0,
    ...overrides,
  });

  it('rejects an amount of 0', () => {
    const result = validatePaymentInput({ amount: 0, payment_method: 'cash' }, context());
    expect(result).toEqual({
      valid: false,
      errorCode: 'validation',
      error: 'Payment amount must be greater than 0.',
    });
  });

  it('rejects a negative amount', () => {
    const result = validatePaymentInput({ amount: -10, payment_method: 'cash' }, context());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('validation');
      expect(result.error).toBe('Payment amount must be greater than 0.');
    }
  });

  it('rejects an invalid payment method', () => {
    // Locked decision #1 (spec): "RR" is dropped, methods stay exactly
    // card | ach | check | cash.
    const result = validatePaymentInput({ amount: 50, payment_method: 'rr' }, context());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCode).toBe('validation');
  });

  it('rejects check with a blank payment_ref', () => {
    const result = validatePaymentInput(
      { amount: 50, payment_method: 'check', payment_ref: '' },
      context()
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('validation');
      expect(result.error).toBe('Check number is required when payment method is check.');
    }
  });

  it('rejects check with a whitespace-only payment_ref', () => {
    const result = validatePaymentInput(
      { amount: 50, payment_method: 'check', payment_ref: '   ' },
      context()
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCode).toBe('validation');
  });

  it('accepts check with a valid payment_ref', () => {
    const result = validatePaymentInput(
      { amount: 50, payment_method: 'check', payment_ref: '1042' },
      context()
    );
    expect(result).toEqual({ valid: true });
  });

  it('rejects a payment that would overpay the bill', () => {
    const result = validatePaymentInput(
      { amount: 30, payment_method: 'ach' },
      context({ existingPaymentsTotal: 80 })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('would_overpay');
      expect(result.error.startsWith(BILL_OVERPAY_PREFIX)).toBe(true);
      expect(result.error).toContain('110.00');
      expect(result.error).toContain('100.00');
    }
  });

  it('rejects any payment against a void bill', () => {
    const result = validatePaymentInput(
      { amount: 10, payment_method: 'cash' },
      context({ billStatus: 'void' })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe('bill_void');
      expect(result.error.startsWith(BILL_VOID_PREFIX)).toBe(true);
    }
  });

  it('checks bill_void before any field validation', () => {
    // SQL: fn_finance_bill_payments_guard_overpay() checks v_bill.status =
    // 'void' before the amount/total math runs at all — mirrored here by
    // checking billStatus before payment_method/amount, so a void bill wins
    // even against an otherwise-invalid candidate payment.
    const result = validatePaymentInput(
      { amount: -5, payment_method: 'bogus' },
      context({ billStatus: 'void' })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCode).toBe('bill_void');
  });

  it('ALLOWS a payment that brings the total to exactly the bill amount (SQL uses >, not >=, for the raise)', () => {
    // SQL: IF v_total > v_bill.amount THEN RAISE EXCEPTION ... — landing
    // exactly on the bill amount does NOT raise. Mirrored here: the > check,
    // not >=, so the boundary case must be valid:true.
    const result = validatePaymentInput(
      { amount: 20, payment_method: 'ach' },
      context({ existingPaymentsTotal: 80 })
    );
    expect(result).toEqual({ valid: true });
  });

  it('does not drift on the exact-boundary case for float-fragile cents (0.01 + 0.06 against a 0.07 bill)', () => {
    const result = validatePaymentInput(
      { amount: 0.06, payment_method: 'cash' },
      context({ billAmount: 0.07, existingPaymentsTotal: 0.01 })
    );
    expect(result).toEqual({ valid: true });
  });

  it('rejects one cent over the exact boundary', () => {
    const result = validatePaymentInput(
      { amount: 20.01, payment_method: 'ach' },
      context({ existingPaymentsTotal: 80 })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCode).toBe('would_overpay');
  });
});

describe('deriveBankConfirmedBillIds', () => {
  // FIX 3 (SPRO-82 adversarial review): bank_confirmed must now be derived
  // per bill from ONLY its check payments — see this function's own doc
  // comment in bill-payments.ts for the full rationale (a bill can hold
  // several check payments, so a bill-scoped finance_reconciliation_log
  // lookup could go true off one cleared check while a second, still-
  // uncleared check payment on the same bill silently vanished from the
  // cash-flow outflow projection).
  const check = (bill_id: string, bank_bs_id: number | null): CheckPaymentForConfirmation => ({
    bill_id,
    bank_bs_id,
  });

  it('excludes a bill with zero check payments', () => {
    expect(deriveBankConfirmedBillIds([])).toEqual(new Set());
  });

  it('confirms a bill whose single check payment is bank-linked', () => {
    const result = deriveBankConfirmedBillIds([check('bill-1', 501)]);
    expect(result.has('bill-1')).toBe(true);
  });

  it('does not confirm a bill whose single check payment is unlinked', () => {
    const result = deriveBankConfirmedBillIds([check('bill-1', null)]);
    expect(result.has('bill-1')).toBe(false);
  });

  it('confirms a bill only when EVERY check payment on it is linked', () => {
    const result = deriveBankConfirmedBillIds([check('bill-1', 501), check('bill-1', 502)]);
    expect(result.has('bill-1')).toBe(true);
  });

  it('the core FIX 3 regression case: one cleared check + one uncleared check on the same bill stays unconfirmed', () => {
    // This is exactly the "check payment A ($500, cleared) and check payment
    // B ($300, NOT cleared)" scenario from the ticket. Order in the array
    // must not matter — the bill must be excluded from the confirmed set
    // regardless of which payment is scanned first, so the bill stays in
    // the cash-flow outflow projection (the safe direction).
    expect(deriveBankConfirmedBillIds([check('bill-1', 501), check('bill-1', null)]).has('bill-1')).toBe(false);
    expect(deriveBankConfirmedBillIds([check('bill-1', null), check('bill-1', 501)]).has('bill-1')).toBe(false);
  });

  it('keeps each bill independent — one confirmed, one not, in the same call', () => {
    const result = deriveBankConfirmedBillIds([
      check('bill-confirmed', 501),
      check('bill-unconfirmed', null),
    ]);
    expect(result.has('bill-confirmed')).toBe(true);
    expect(result.has('bill-unconfirmed')).toBe(false);
  });

  it('ignores bank_bs_id of 0 correctly (falsy but not null)', () => {
    // 0 is a valid bigint id — must be treated as "linked", not coerced to
    // false the way a naive `!payment.bank_bs_id` check would.
    const result = deriveBankConfirmedBillIds([check('bill-1', 0)]);
    expect(result.has('bill-1')).toBe(true);
  });
});

describe('mapPaymentDbErrorCode', () => {
  it('maps a BILL_OVERPAY: prefixed message to would_overpay', () => {
    expect(
      mapPaymentDbErrorCode('BILL_OVERPAY: Payments would total 110.00, exceeding the bill amount of 100.00.')
    ).toBe('would_overpay');
  });

  it('maps a BILL_VOID: prefixed message to bill_void', () => {
    expect(mapPaymentDbErrorCode('BILL_VOID: Cannot record a payment against a voided bill.')).toBe(
      'bill_void'
    );
  });

  it('FIX 7: maps trg_finance_bills_guard_amount_reduction\'s BILL_OVERPAY: message to would_overpay', () => {
    // This is the new DB-level backstop for updateBill()'s TOCTOU-racy
    // read-then-write amount-reduction check (actions/finance.ts) — it
    // raises with the same BILL_OVERPAY: prefix as the payments-ledger
    // overpay guard, specifically so this same mapping classifies it
    // correctly and stripPaymentErrorPrefix() below keeps the sentinel off
    // the user's screen.
    expect(
      mapPaymentDbErrorCode(
        'BILL_OVERPAY: Cannot reduce the bill amount to 50.00, below the 80.00 already recorded in payments. Delete or reduce a payment first.'
      )
    ).toBe('would_overpay');
  });

  it('returns undefined for an unrelated Postgres message', () => {
    expect(mapPaymentDbErrorCode('duplicate key value violates unique constraint "uidx_fbp_bank_bill"')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(mapPaymentDbErrorCode('')).toBeUndefined();
  });
});

describe('stripPaymentErrorPrefix', () => {
  it('strips the BILL_OVERPAY: prefix and tidies the leading whitespace', () => {
    expect(
      stripPaymentErrorPrefix(
        'BILL_OVERPAY: Payments would total 110.00, exceeding the bill amount of 100.00. Edit the bill amount first, or reduce this payment.'
      )
    ).toBe(
      'Payments would total 110.00, exceeding the bill amount of 100.00. Edit the bill amount first, or reduce this payment.'
    );
  });

  it('strips the BILL_VOID: prefix and tidies the leading whitespace', () => {
    expect(
      stripPaymentErrorPrefix('BILL_VOID: Cannot record a payment against a voided bill. Un-void the bill first.')
    ).toBe('Cannot record a payment against a voided bill. Un-void the bill first.');
  });

  it('returns a message with no recognized prefix completely unchanged', () => {
    expect(stripPaymentErrorPrefix('Bill not found')).toBe('Bill not found');
    expect(stripPaymentErrorPrefix('duplicate key value violates unique constraint "uidx_fbp_bank_bill"')).toBe(
      'duplicate key value violates unique constraint "uidx_fbp_bank_bill"'
    );
  });

  it('does not strip a prefix that only appears mid-string', () => {
    expect(stripPaymentErrorPrefix('see BILL_OVERPAY: for details')).toBe('see BILL_OVERPAY: for details');
  });

  it('is idempotent — stripping an already-stripped message is a no-op', () => {
    const once = stripPaymentErrorPrefix('BILL_OVERPAY: Payments would total 110.00.');
    expect(stripPaymentErrorPrefix(once)).toBe(once);
  });
});

describe('selectPaymentToLink', () => {
  // SPRO-82 recon-fix (spec section A2): mirrors the payment-selection query
  // in assign_reconciliation_match(), supabase/migrations/
  // 20260806220000_recon_link_payments.sql — "link the closest unlinked
  // payment on this bill, or create a new one if there isn't one" instead of
  // always creating (the bug: confirming a proposal on an already-paid bill
  // inserted a second payment and tripped the overpay guard).
  const link = (
    amount: number,
    paid_date: string,
    created_at: string,
    overrides: Partial<PaymentForLink> = {}
  ): PaymentForLink => ({ amount, paid_date, created_at, ...overrides });

  it('returns create when the bill has no unlinked payments', () => {
    // SQL: SELECT ... WHERE bill_id = ... AND bank_bs_id IS NULL ... — an
    // empty result set (no unlinked payments passed in) falls to the ELSE
    // branch, which INSERTs a new payment rather than linking anything.
    expect(selectPaymentToLink(100, [])).toEqual({ action: 'create' });
  });

  it('links a single exact match', () => {
    const p = link(1597.5, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(selectPaymentToLink(1597.5, [p])).toEqual({ action: 'link', payment: p });
  });

  it('links a single payment off by $0.005 — inside the $0.01 tolerance', () => {
    // toCents rounds 100.005 to the nearest cent, same rounding the ledger's
    // NUMERIC(12,2) columns already impose, so the effective diff is $0.00
    // or $0.01 depending on rounding direction — either way within tolerance.
    const p = link(100.0, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(selectPaymentToLink(100.005, [p])).toEqual({ action: 'link', payment: p });
  });

  it('flags a single payment off by $0.02 as a mismatch, not a link', () => {
    // SQL: IF ABS(v_payment.amount - v_bank_amount) <= 0.01 THEN link ELSE
    // amount_mismatch — $0.02 is outside the tolerance.
    const p = link(100.0, '2026-08-01', '2026-08-01T10:00:00Z');
    expect(selectPaymentToLink(100.02, [p])).toEqual({ action: 'mismatch', payment: p });
  });

  it('picks the closest-amount payment even when it is not the oldest', () => {
    // The case a naive "oldest unlinked payment" rule would get wrong: the
    // oldest payment here is $50 (way off), but a later, exact $200 payment
    // exists — ORDER BY ABS(amount - bank_amount) must win over ORDER BY
    // paid_date/created_at alone.
    const oldestButFar = link(50.0, '2026-07-01', '2026-07-01T09:00:00Z');
    const exactButNewer = link(200.0, '2026-08-10', '2026-08-10T09:00:00Z');
    const result = selectPaymentToLink(200.0, [oldestButFar, exactButNewer]);
    expect(result).toEqual({ action: 'link', payment: exactButNewer });
  });

  it('breaks an equidistant tie by the older paid_date, deterministically regardless of array order', () => {
    // SQL: ORDER BY ABS(amount - v_bank_amount), paid_date, created_at —
    // both payments are $10 off (one over, one under), so paid_date decides.
    const older = link(190.0, '2026-08-01', '2026-08-01T09:00:00Z');
    const newer = link(210.0, '2026-08-15', '2026-08-15T09:00:00Z');
    expect(selectPaymentToLink(200.0, [older, newer])).toEqual({ action: 'mismatch', payment: older });
    // Order in the input array must not change the winner.
    expect(selectPaymentToLink(200.0, [newer, older])).toEqual({ action: 'mismatch', payment: older });
  });

  it('breaks an equidistant, same-paid_date tie by the older created_at', () => {
    const earlierCreated = link(190.0, '2026-08-01', '2026-08-01T09:00:00Z');
    const laterCreated = link(210.0, '2026-08-01', '2026-08-01T15:00:00Z');
    expect(selectPaymentToLink(200.0, [earlierCreated, laterCreated])).toEqual({
      action: 'mismatch',
      payment: earlierCreated,
    });
    expect(selectPaymentToLink(200.0, [laterCreated, earlierCreated])).toEqual({
      action: 'mismatch',
      payment: earlierCreated,
    });
  });

  it('does not drift on a cents-precision case plain float arithmetic would get wrong', () => {
    // Raw IEEE-754: 0.07 - (0.01 + 0.06) leaves a residual epsilon instead of
    // 0 — a naive `Math.abs(payment.amount - bankAmount) <= 0.01` still
    // happens to pass here, but the closest-match ranking across candidates
    // must be decided in exact cents, not float subtraction, the same way
    // computeBillTotals() sums in cents (see toCents()'s doc comment).
    const exact = link(0.07, '2026-08-01', '2026-08-01T10:00:00Z');
    const rounding = link(0.1, '2026-08-02', '2026-08-02T10:00:00Z');
    expect(selectPaymentToLink(0.07, [rounding, exact])).toEqual({ action: 'link', payment: exact });
  });

  it('the real production shape: bank $1,597.50 vs one unlinked $1,597.50 payment links', () => {
    // The stuck-in-production case from the spec (Helton Law Firm, log
    // 9dafdd93-fdf8-475f-8360-4cec916f77a4, bank 1124 −$1,597.50 against one
    // unlinked $1,597.50 ach payment) — must LINK, not create a second
    // payment that trips the overpay guard.
    const p = link(1597.5, '2026-08-05', '2026-08-05T12:00:00Z', {});
    expect(selectPaymentToLink(1597.5, [p])).toEqual({ action: 'link', payment: p });
  });
});
