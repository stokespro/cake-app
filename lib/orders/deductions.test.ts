// SPRO-148: coverage for the pure order-discount/credit helpers.
//
// The pair expectations here are derived directly from the two CHECK
// constraints in
// supabase/migrations/20260918120000_add_order_discounts_credits.sql
// (orders_discount_pair_check / orders_credit_pair_check) — this file exists
// to keep validateOrderDeductions() and that SQL in lockstep, so a case is
// marked "SQL:" whenever it exists specifically because the constraint says
// so. The combined-deduction ceiling has no SQL counterpart (it is
// cross-table) and is marked "TS-only:". Follows the house style of
// lib/finance/bill-payments.test.ts.

import { describe, expect, it } from 'vitest';
import {
  MAX_DEDUCTION_REASON_LENGTH,
  breakdownFromOrder,
  calculateItemSubtotal,
  calculateOrderTotals,
  hasOrderDeductions,
  normalizeDeduction,
  orderRevenueFromItems,
  roundCurrency,
  validateDeduction,
  validateOrderDeductions,
} from './deductions';

const NO_DEDUCTIONS = {
  discount_amount: null,
  discount_reason: null,
  credit_amount: null,
  credit_reason: null,
};

describe('roundCurrency', () => {
  it('rounds to whole cents', () => {
    expect(roundCurrency(10.005)).toBe(10.01);
    expect(roundCurrency(10.004)).toBe(10);
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
  });

  it('maps non-finite input to 0 rather than propagating NaN', () => {
    expect(roundCurrency(Number.NaN)).toBe(0);
    expect(roundCurrency(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('calculateItemSubtotal', () => {
  it('sums line totals', () => {
    expect(calculateItemSubtotal([{ line_total: 100 }, { line_total: 50.5 }])).toBe(150.5);
  });

  it('ignores items marked deleted — only ACTIVE items count', () => {
    expect(
      calculateItemSubtotal([{ line_total: 100 }, { line_total: 50, _deleted: true }])
    ).toBe(100);
  });

  it('treats missing and non-finite line totals as 0', () => {
    expect(
      calculateItemSubtotal([{ line_total: 100 }, { line_total: null }, { line_total: Number.NaN }, {}])
    ).toBe(100);
  });

  it('returns 0 for no items, null and undefined', () => {
    expect(calculateItemSubtotal([])).toBe(0);
    expect(calculateItemSubtotal(null)).toBe(0);
    expect(calculateItemSubtotal(undefined)).toBe(0);
  });
});

describe('normalizeDeduction', () => {
  it('treats empty string, null and undefined amounts as absent', () => {
    expect(normalizeDeduction({ amount: '', reason: '' })).toEqual({ amount: null, reason: null });
    expect(normalizeDeduction({ amount: null, reason: null })).toEqual({ amount: null, reason: null });
    expect(normalizeDeduction(undefined)).toEqual({ amount: null, reason: null });
  });

  it('trims the reason and treats whitespace-only as absent', () => {
    expect(normalizeDeduction({ amount: 5, reason: '  damaged case  ' })).toEqual({
      amount: 5,
      reason: 'damaged case',
    });
    expect(normalizeDeduction({ amount: 5, reason: '   ' }).reason).toBeNull();
  });

  it('parses numeric strings from form inputs', () => {
    expect(normalizeDeduction({ amount: '25.50', reason: 'x' }).amount).toBe(25.5);
  });

  it('preserves an unparseable amount as NaN instead of coercing it to 0', () => {
    // Silent coercion of a typo'd amount to 0 would hide the error; NaN lets
    // validateDeduction() reject it.
    expect(normalizeDeduction({ amount: 'abc', reason: 'x' }).amount).toBeNaN();
  });
});

describe('validateDeduction', () => {
  it('SQL: accepts a fully absent pair (both NULL)', () => {
    expect(validateDeduction('discount', { amount: null, reason: null })).toBeNull();
  });

  it('SQL: accepts a positive amount with a non-blank reason', () => {
    expect(validateDeduction('discount', { amount: 25, reason: 'volume deal' })).toBeNull();
    expect(validateDeduction('credit', { amount: 0.01, reason: 'rounding' })).toBeNull();
  });

  it('SQL: rejects an amount with no reason (missing pair)', () => {
    expect(validateDeduction('discount', { amount: 25, reason: null })).toBe('Discount reason is required.');
    expect(validateDeduction('credit', { amount: 25, reason: null })).toBe('Credit reason is required.');
  });

  it('SQL: rejects a blank reason', () => {
    // '   ' normalizes to null, which is the missing-pair error.
    const normalized = normalizeDeduction({ amount: 25, reason: '   ' });
    expect(validateDeduction('discount', normalized)).toBe('Discount reason is required.');
  });

  it('SQL: rejects a reason with no amount (missing pair)', () => {
    expect(validateDeduction('credit', { amount: null, reason: 'goodwill' })).toBe(
      'Credit amount is required when a credit reason is entered.'
    );
  });

  it('SQL: rejects zero and negative amounts (must be strictly positive)', () => {
    expect(validateDeduction('discount', { amount: 0, reason: 'x' })).toBe(
      'Discount amount must be greater than zero.'
    );
    expect(validateDeduction('discount', { amount: -5, reason: 'x' })).toBe(
      'Discount amount must be greater than zero.'
    );
  });

  it('rejects sub-cent amounts — positive as typed, 0.00 once normalized for storage', () => {
    // Review fix: every write path persists roundCurrency(amount), so 0.001
    // through 0.004 used to pass `> 0`, be stored as 0.00, and only be caught
    // by the `amount > 0` CHECK part-way through the write.
    for (const amount of [0.001, 0.002, 0.003, 0.004]) {
      expect(validateDeduction('discount', { amount, reason: 'x' })).toBe(
        'Discount amount must be at least $0.01.'
      );
      expect(validateDeduction('credit', { amount, reason: 'x' })).toBe(
        'Credit amount must be at least $0.01.'
      );
    }
  });

  it('accepts the smallest cent-representable amount, and anything rounding up to it', () => {
    expect(validateDeduction('discount', { amount: 0.01, reason: 'x' })).toBeNull();
    expect(validateDeduction('credit', { amount: 0.01, reason: 'x' })).toBeNull();
    // 0.005 normalizes to 0.01, so it is representable and stays accepted.
    expect(validateDeduction('discount', { amount: 0.005, reason: 'x' })).toBeNull();
  });

  it('rejects non-finite amounts', () => {
    expect(validateDeduction('credit', { amount: Number.NaN, reason: 'x' })).toBe(
      'Credit amount must be a valid number.'
    );
    expect(validateDeduction('credit', { amount: Number.POSITIVE_INFINITY, reason: 'x' })).toBe(
      'Credit amount must be a valid number.'
    );
  });

  it(`SQL: rejects a reason longer than ${MAX_DEDUCTION_REASON_LENGTH} characters, accepts exactly that many`, () => {
    const atLimit = 'a'.repeat(MAX_DEDUCTION_REASON_LENGTH);
    expect(validateDeduction('discount', { amount: 1, reason: atLimit })).toBeNull();
    expect(validateDeduction('discount', { amount: 1, reason: `${atLimit}a` })).toBe(
      'Discount reason must be 255 characters or less.'
    );
  });

  it('SQL: measures the length of the TRIMMED reason', () => {
    const padded = `  ${'a'.repeat(MAX_DEDUCTION_REASON_LENGTH)}  `;
    expect(validateDeduction('discount', normalizeDeduction({ amount: 1, reason: padded }))).toBeNull();
  });
});

describe('calculateOrderTotals', () => {
  it('nets discount and credit off the subtotal', () => {
    expect(
      calculateOrderTotals(1000, {
        discount_amount: 100,
        discount_reason: 'volume',
        credit_amount: 50,
        credit_reason: 'return',
      })
    ).toEqual({ subtotal: 1000, discount: 100, credit: 50, deductions: 150, netTotal: 850 });
  });

  it('leaves the subtotal untouched when there are no deductions', () => {
    expect(calculateOrderTotals(1000, NO_DEDUCTIONS)).toEqual({
      subtotal: 1000,
      discount: 0,
      credit: 0,
      deductions: 0,
      netTotal: 1000,
    });
  });

  it('rounds cent drift out of the net total', () => {
    const totals = calculateOrderTotals(0.3, {
      discount_amount: 0.1,
      discount_reason: 'x',
      credit_amount: 0.2,
      credit_reason: 'y',
    });
    expect(totals.netTotal).toBe(0);
  });
});

describe('validateOrderDeductions', () => {
  it('accepts an order with neither deduction', () => {
    const result = validateOrderDeductions({ subtotal: 500 });
    expect(result).toEqual({
      ok: true,
      fields: NO_DEDUCTIONS,
      totals: { subtotal: 500, discount: 0, credit: 0, deductions: 0, netTotal: 500 },
    });
  });

  it('accepts a discount and a credit coexisting', () => {
    const result = validateOrderDeductions({
      subtotal: 1000,
      discount: { amount: 100, reason: '  volume deal  ' },
      credit: { amount: 250, reason: 'damaged pallet' },
    });
    expect(result).toEqual({
      ok: true,
      fields: {
        discount_amount: 100,
        discount_reason: 'volume deal',
        credit_amount: 250,
        credit_reason: 'damaged pallet',
      },
      totals: { subtotal: 1000, discount: 100, credit: 250, deductions: 350, netTotal: 650 },
    });
  });

  it('TS-only: allows combined deductions to land exactly on the subtotal (net 0)', () => {
    const result = validateOrderDeductions({
      subtotal: 300,
      discount: { amount: 100, reason: 'a' },
      credit: { amount: 200, reason: 'b' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.totals.netTotal).toBe(0);
  });

  it('TS-only: rejects combined deductions above the subtotal — no negative total', () => {
    const result = validateOrderDeductions({
      subtotal: 300,
      discount: { amount: 100, reason: 'a' },
      credit: { amount: 250, reason: 'b' },
    });
    expect(result).toEqual({
      ok: false,
      error: 'Discount and credit together ($350.00) cannot exceed the order subtotal of $300.00.',
    });
  });

  it('TS-only: rejects a single deduction above the subtotal', () => {
    const result = validateOrderDeductions({
      subtotal: 100,
      discount: { amount: 100.01, reason: 'a' },
    });
    expect(result.ok).toBe(false);
  });

  it('propagates the discount pair error', () => {
    expect(validateOrderDeductions({ subtotal: 500, discount: { amount: 25, reason: '' } })).toEqual({
      ok: false,
      error: 'Discount reason is required.',
    });
  });

  it('propagates the credit pair error', () => {
    expect(validateOrderDeductions({ subtotal: 500, credit: { amount: '', reason: 'goodwill' } })).toEqual({
      ok: false,
      error: 'Credit amount is required when a credit reason is entered.',
    });
  });

  it('rejects negative and non-finite amounts before the ceiling check', () => {
    expect(validateOrderDeductions({ subtotal: 500, discount: { amount: -1, reason: 'a' } }).ok).toBe(false);
    expect(validateOrderDeductions({ subtotal: 500, credit: { amount: 'abc', reason: 'a' } })).toEqual({
      ok: false,
      error: 'Credit amount must be a valid number.',
    });
  });

  it('rejects a non-finite or negative subtotal', () => {
    expect(validateOrderDeductions({ subtotal: Number.NaN }).ok).toBe(false);
    expect(validateOrderDeductions({ subtotal: -1 }).ok).toBe(false);
  });

  it('rounds persisted amounts to cents', () => {
    const result = validateOrderDeductions({
      subtotal: 500,
      discount: { amount: 10.005, reason: 'a' },
    });
    expect(result.ok && result.fields.discount_amount).toBe(10.01);
  });

  it('rejects a sub-cent amount rather than persisting it as 0.00', () => {
    // The pair would reach the database as amount 0.00 with a non-null reason,
    // which the CHECK rejects — so it has to fail here, before the write.
    expect(validateOrderDeductions({ subtotal: 500, discount: { amount: 0.003, reason: 'a' } })).toEqual({
      ok: false,
      error: 'Discount amount must be at least $0.01.',
    });
    expect(validateOrderDeductions({ subtotal: 500, credit: { amount: '0.004', reason: 'a' } })).toEqual({
      ok: false,
      error: 'Credit amount must be at least $0.01.',
    });
  });

  it('keeps a one-cent deduction, normalized and netted off the total', () => {
    const result = validateOrderDeductions({
      subtotal: 500,
      discount: { amount: '0.01', reason: 'a' },
    });
    expect(result.ok && result.fields.discount_amount).toBe(0.01);
    expect(result.ok && result.totals.netTotal).toBe(499.99);
  });
});

describe('hasOrderDeductions', () => {
  it('is false for null, undefined and an order with neither deduction', () => {
    expect(hasOrderDeductions(null)).toBe(false);
    expect(hasOrderDeductions(undefined)).toBe(false);
    expect(hasOrderDeductions(NO_DEDUCTIONS)).toBe(false);
  });

  it('is true when either deduction is present', () => {
    expect(hasOrderDeductions({ ...NO_DEDUCTIONS, discount_amount: 5 })).toBe(true);
    expect(hasOrderDeductions({ ...NO_DEDUCTIONS, credit_amount: 5 })).toBe(true);
  });
});

describe('breakdownFromOrder', () => {
  it('reconstructs the subtotal by adding the deductions back to the net total', () => {
    expect(
      breakdownFromOrder({ total_price: 850, discount_amount: 100, credit_amount: 50 })
    ).toEqual({ subtotal: 1000, discount: 100, credit: 50, deductions: 150, netTotal: 850 });
  });

  it('treats a legacy order with no deduction columns as subtotal === net total', () => {
    expect(breakdownFromOrder({ total_price: 1000 })).toEqual({
      subtotal: 1000,
      discount: 0,
      credit: 0,
      deductions: 0,
      netTotal: 1000,
    });
  });
});

describe('orderRevenueFromItems', () => {
  it('uses the active line-item subtotal less persisted deductions', () => {
    expect(
      orderRevenueFromItems({
        total_price: 850,
        discount_amount: 100,
        credit_amount: 50,
        order_items: [{ line_total: 600 }, { line_total: 400 }],
      })
    ).toBe(850);
  });

  it('recomputes from items even when total_price has drifted', () => {
    expect(
      orderRevenueFromItems({
        total_price: 999999,
        discount_amount: 100,
        credit_amount: null,
        order_items: [{ line_total: 1000 }],
      })
    ).toBe(900);
  });

  it('falls back to total_price for legacy zero-item orders', () => {
    expect(orderRevenueFromItems({ total_price: 1234.56, order_items: [] })).toBe(1234.56);
    expect(orderRevenueFromItems({ total_price: 1234.56, order_items: null })).toBe(1234.56);
    expect(orderRevenueFromItems({ total_price: 1234.56 })).toBe(1234.56);
  });

  it('does NOT apply deductions to the legacy zero-item fallback', () => {
    // A header-only order's total_price is already whatever was recorded; the
    // deduction columns cannot exist on one, so nothing is subtracted.
    expect(
      orderRevenueFromItems({ total_price: 1000, discount_amount: 100, order_items: [] })
    ).toBe(1000);
  });

  it('returns 0 for a missing total_price with no items', () => {
    expect(orderRevenueFromItems({ total_price: null, order_items: [] })).toBe(0);
  });
});
