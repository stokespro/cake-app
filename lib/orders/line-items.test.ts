// SPRO-148 review fix: the dispensary Orders tab could not edit an existing
// order. getCustomerOrders() never selected order_items, so <OrderSheet> opened
// with nothing to edit and refused to submit ("at least one item").
//
// The fetch side of that is covered in actions/customers.test.ts. This file
// covers the MAP side: persisted order items must arrive as editable form
// lines, priced by the same rule actions/orders.ts applies on the write
// (cases x units_per_case x unit_price) and labelled even when the SKU has
// since dropped out of the picker list.
//
// Follows the house style of lib/orders/deductions.test.ts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_UNITS_PER_CASE, mapOrderItemsToForm } from './line-items';

/** No customer-pricing rule for anything — the common case. */
const noPricing = () => null;

const PICKER = [
  { id: 'sku-a', code: 'AS', name: 'Aloha Sugar', units_per_case: 32 },
  { id: 'sku-b', code: 'BD', name: 'Blue Dream', units_per_case: 10 },
];

describe('mapOrderItemsToForm', () => {
  it('maps a persisted item onto an editable line, cases x units_per_case x unit_price', () => {
    const items = [{ sku_id: 'sku-a', quantity: 2, unit_price: 10 }];

    expect(mapOrderItemsToForm(items, PICKER, noPricing)).toEqual([
      {
        sku_id: 'sku-a',
        sku_code: 'AS',
        sku_name: 'Aloha Sugar',
        cases: 2,
        units_per_case: 32,
        quantity: 64,
        unit_price: 10,
        line_total: 640,
      },
    ]);
  });

  it('reads CASES out of order_items.quantity, not units', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-b', quantity: 3, unit_price: 5 }],
      PICKER,
      noPricing
    );

    expect(line.cases).toBe(3);
    expect(line.quantity).toBe(30); // 3 cases x 10 units
    expect(line.line_total).toBe(150);
  });

  it('maps every item on the order, in order', () => {
    const lines = mapOrderItemsToForm(
      [
        { sku_id: 'sku-a', quantity: 1, unit_price: 2 },
        { sku_id: 'sku-b', quantity: 1, unit_price: 3 },
      ],
      PICKER,
      noPricing
    );

    expect(lines.map(l => l.sku_id)).toEqual(['sku-a', 'sku-b']);
    expect(lines.map(l => l.line_total)).toEqual([64, 30]);
  });

  it('falls back to the SKU joined on the item when it is missing from the picker', () => {
    // An order can hold a SKU that has since gone out of stock, so the create
    // picker no longer lists it. It must still show its real name and its real
    // units_per_case rather than silently repricing against the 32 default.
    const [line] = mapOrderItemsToForm(
      [
        {
          sku_id: 'sku-gone',
          quantity: 2,
          unit_price: 4,
          sku: { code: 'GX', name: 'Gone Extract', units_per_case: 6 },
        },
      ],
      PICKER,
      noPricing
    );

    expect(line.sku_code).toBe('GX');
    expect(line.sku_name).toBe('Gone Extract');
    expect(line.units_per_case).toBe(6);
    expect(line.line_total).toBe(48); // 2 x 6 x 4
  });

  it('prefers the picker entry over the joined SKU when both are present', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-a', quantity: 1, unit_price: 1, sku: { code: 'STALE', name: 'Stale', units_per_case: 99 } }],
      PICKER,
      noPricing
    );

    expect(line.sku_code).toBe('AS');
    expect(line.units_per_case).toBe(32);
  });

  it(`falls back to ${DEFAULT_UNITS_PER_CASE} units per case only when the SKU cannot be resolved at all`, () => {
    const [line] = mapOrderItemsToForm([{ sku_id: 'sku-?', quantity: 1, unit_price: 1 }], PICKER, noPricing);

    expect(line.units_per_case).toBe(DEFAULT_UNITS_PER_CASE);
    expect(line.sku_name).toBe('Unknown SKU');
    expect(line.sku_code).toBe('');
  });

  it('keeps a persisted unit price and does NOT reprice it from customer pricing', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-a', quantity: 1, unit_price: 7 }],
      PICKER,
      () => 99
    );

    expect(line.unit_price).toBe(7);
    expect(line.line_total).toBe(224);
  });

  it('falls back to customer pricing only for a line persisted without a unit price', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-a', quantity: 1, unit_price: null }],
      PICKER,
      () => 3
    );

    expect(line.unit_price).toBe(3);
    expect(line.line_total).toBe(96);
  });

  it('leaves an unpriceable line at null so the form demands a price', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-a', quantity: 1, unit_price: null }],
      PICKER,
      noPricing
    );

    expect(line.unit_price).toBeNull();
    expect(line.line_total).toBe(0);
  });

  it('rounds the line preview to cents, matching what the server persists', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-b', quantity: 1, unit_price: 0.07 }],
      PICKER,
      noPricing
    );

    expect(line.line_total).toBe(0.7);
  });

  it('returns an empty list for no items, null and undefined', () => {
    expect(mapOrderItemsToForm([], PICKER, noPricing)).toEqual([]);
    expect(mapOrderItemsToForm(null, PICKER, noPricing)).toEqual([]);
    expect(mapOrderItemsToForm(undefined, PICKER, noPricing)).toEqual([]);
  });

  it('still maps when the picker list has not loaded yet, via the joined SKU', () => {
    const [line] = mapOrderItemsToForm(
      [{ sku_id: 'sku-a', quantity: 1, unit_price: 2, sku: { code: 'AS', name: 'Aloha Sugar', units_per_case: 32 } }],
      [],
      noPricing
    );

    expect(line.sku_code).toBe('AS');
    expect(line.line_total).toBe(64);
  });
});
