// SPRO-199: the rep name and updated-at display helpers for the orders page.
//
// Follows the house style of lib/orders/deductions.test.ts.

import { describe, expect, it } from 'vitest';
import { formatOrderUpdatedAt, getAssignedRepName } from './order-details';

describe('getAssignedRepName', () => {
  it('returns the rep name when the customer has an assigned rep', () => {
    const order = { customer: { assigned_sales: { id: 'u1', name: 'Jordan Reyes' } } };
    expect(getAssignedRepName(order)).toBe('Jordan Reyes');
  });

  it('returns null when the customer has no assigned rep', () => {
    expect(getAssignedRepName({ customer: { assigned_sales: null } })).toBeNull();
    expect(getAssignedRepName({ customer: {} })).toBeNull();
  });

  it('returns null when the customer is missing', () => {
    expect(getAssignedRepName({ customer: null })).toBeNull();
    expect(getAssignedRepName({})).toBeNull();
    expect(getAssignedRepName(null)).toBeNull();
    expect(getAssignedRepName(undefined)).toBeNull();
  });

  it('returns null for a blank rep name rather than an empty label', () => {
    expect(getAssignedRepName({ customer: { assigned_sales: { name: '   ' } } })).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(getAssignedRepName({ customer: { assigned_sales: { name: ' Sam ' } } })).toBe('Sam');
  });
});

describe('formatOrderUpdatedAt', () => {
  // No timezone suffix: parseISO reads it as local time, so the expected
  // output is the same in every timezone the tests run in.
  const ts = '2026-10-06T15:45:00';

  it('formats a date for list views', () => {
    expect(formatOrderUpdatedAt(ts)).toBe('Oct 6, 2026');
  });

  it('formats date and time for the sheet', () => {
    expect(formatOrderUpdatedAt(ts, true)).toBe('Oct 6, 2026 3:45 PM');
  });

  it('returns null for missing or unparseable values', () => {
    expect(formatOrderUpdatedAt(null)).toBeNull();
    expect(formatOrderUpdatedAt(undefined)).toBeNull();
    expect(formatOrderUpdatedAt('')).toBeNull();
    expect(formatOrderUpdatedAt('not-a-date')).toBeNull();
  });
});
