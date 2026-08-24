// Coverage for the two pure pieces of SPRO-128 logic that live in the
// allocation engine: deriveFormat() (structured-column format derivation,
// never string-parsing the free-form SKU code) and computeInventoryState()
// (the short > restage > low > ok > idle precedence, including the
// staged===0 & pending>0 "restage" blind spot the redesign exists to fix).

import { describe, expect, it } from 'vitest';
import { deriveFormat, computeInventoryState, generateSKUStatus } from './allocation-engine';
import type { InventoryMap, Order } from './types';

describe('deriveFormat', () => {
  it('maps product_type "Bites" to Bites regardless of grams/units', () => {
    expect(deriveFormat('Bites', 1, 1)).toBe('Bites');
    expect(deriveFormat('Bites', '3.50', '8')).toBe('Bites');
  });

  it('maps A Buds + 14g to Half', () => {
    expect(deriveFormat('A Buds', 14, 1)).toBe('Half');
  });

  it('maps A Buds + 3.5g + 8 units to Variety', () => {
    expect(deriveFormat('A Buds', 3.5, 8)).toBe('Variety');
  });

  it('maps A Buds + 3.5g (units != 8) to Eighth', () => {
    expect(deriveFormat('A Buds', 3.5, 1)).toBe('Eighth');
  });

  it('falls back to Other for unrecognized product types', () => {
    expect(deriveFormat('Concentrate', 1, 1)).toBe('Other');
    expect(deriveFormat(null, 3.5, 8)).toBe('Other');
    expect(deriveFormat(undefined, 14, 1)).toBe('Other');
  });

  it('coerces numeric-string grams_per_unit/units_per_case (Supabase numeric columns) instead of strict-equality comparing strings', () => {
    // Supabase returns numeric columns as strings, e.g. "3.50" — a naive
    // `gramsPerUnit === 3.5` (string vs number) would always be false.
    expect(deriveFormat('A Buds', '14.00', '1')).toBe('Half');
    expect(deriveFormat('A Buds', '3.50', '8')).toBe('Variety');
    expect(deriveFormat('A Buds', '3.50', '1')).toBe('Eighth');
  });

  it('tolerates minor floating point drift on grams_per_unit', () => {
    expect(deriveFormat('A Buds', 3.5000001, 8)).toBe('Variety');
    expect(deriveFormat('A Buds', 13.999999, 1)).toBe('Half');
  });

  it('never derives a format by parsing the SKU code string', () => {
    // Regression guard: deriveFormat's signature takes no `code` parameter
    // at all — a SKU coded "BG-VAR-8" with mismatched structured columns
    // (e.g. mis-set grams_per_unit) must follow the structured data, not
    // the code's "VAR" substring. There's no code argument to even parse.
    expect(deriveFormat('A Buds', 14, 1)).toBe('Half'); // even if code said "-VAR-8"
  });
});

describe('computeInventoryState', () => {
  it('returns short when gap > 0, taking precedence over everything else', () => {
    expect(computeInventoryState({ staged: 0, pending: 5, gap: 3 })).toBe('short');
    // Even with staged >= LOW_STOCK_THRESHOLD, a gap still means SHORT.
    expect(computeInventoryState({ staged: 10, pending: 20, gap: 2 })).toBe('short');
  });

  it('returns restage when staged===0 and pending>0 and there is no gap — the pre-SPRO-128 blind spot', () => {
    expect(computeInventoryState({ staged: 0, pending: 4, gap: 0 })).toBe('restage');
  });

  it('short outranks restage: a gap with staged===0 must render SHORT, not RESTAGE', () => {
    expect(computeInventoryState({ staged: 0, pending: 10, gap: 1 })).toBe('short');
  });

  it('returns low when 0 < staged < 4', () => {
    expect(computeInventoryState({ staged: 1, pending: 0, gap: 0 })).toBe('low');
    expect(computeInventoryState({ staged: 3, pending: 5, gap: 0 })).toBe('low');
  });

  it('returns ok when staged >= 4', () => {
    expect(computeInventoryState({ staged: 4, pending: 0, gap: 0 })).toBe('ok');
    expect(computeInventoryState({ staged: 8, pending: 2, gap: 0 })).toBe('ok');
  });

  it('returns idle when staged===0, pending===0, gap===0', () => {
    expect(computeInventoryState({ staged: 0, pending: 0, gap: 0 })).toBe('idle');
  });
});

describe('generateSKUStatus (state wiring)', () => {
  it('surfaces the restage blind spot for a SKU at staged=0 with open pending orders', () => {
    const inventory: InventoryMap = {
      BG: { cased: 3, filled: 3, staged: 0 },
    };
    const orders: Order[] = [
      {
        id: 'o1',
        customerName: 'Test Dispensary',
        status: 'Pending',
        deliveryDate: null,
        lastDeliveryDate: '',
        orderBackup: null,
        lineItems: [{ sku: 'BG', quantity: 2 }],
        rowNumber: 1,
      },
    ];

    const [status] = generateSKUStatus(inventory, orders);
    expect(status.staged).toBe(0);
    expect(status.gap).toBe(0); // cased+filled=6 covers pending=2, no gap
    expect(status.state).toBe('restage');
  });

  it('reports short (not restage) once demand exceeds total on-hand', () => {
    const inventory: InventoryMap = {
      'BIS-B': { cased: 0, filled: 0, staged: 0 },
    };
    const orders: Order[] = [
      {
        id: 'o1',
        customerName: 'Test Dispensary',
        status: 'Confirmed',
        deliveryDate: null,
        lastDeliveryDate: '',
        orderBackup: null,
        lineItems: [{ sku: 'BIS-B', quantity: 5 }],
        rowNumber: 1,
      },
    ];

    const [status] = generateSKUStatus(inventory, orders);
    expect(status.gap).toBe(5);
    expect(status.state).toBe('short');
  });
});
