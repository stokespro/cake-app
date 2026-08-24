// Coverage for the SPRO-128 matrix grouping/sorting logic — the pure
// functions the desktop table and mobile per-strain cards both build on.

import { describe, expect, it } from 'vitest';
import { buildInventoryMatrix, getAttentionItems, FORMAT_COLUMNS } from './inventory-matrix';
import type { SKUStatus } from './types';

function makeSku(overrides: Partial<SKUStatus> & { sku: string }): SKUStatus {
  return {
    cased: 0,
    filled: 0,
    staged: 0,
    pending: 0,
    gap: 0,
    lowStock: false,
    state: 'idle',
    ...overrides,
  };
}

describe('FORMAT_COLUMNS', () => {
  it('is fixed to Eighth, Half, Bites, Variety — the stable column order both the desktop table and mobile grid render in', () => {
    expect(FORMAT_COLUMNS).toEqual(['Eighth', 'Half', 'Bites', 'Variety']);
  });
});

describe('buildInventoryMatrix', () => {
  it('rows are alphabetical strain names, independent of input order', () => {
    const skus: SKUStatus[] = [
      makeSku({ sku: 'CR', strainName: 'Cake Runtz', format: 'Eighth' }),
      makeSku({ sku: 'BG', strainName: 'Bacio Gelato', format: 'Eighth' }),
      makeSku({ sku: 'AS', strainName: 'Aloha Sugar', format: 'Variety' }),
    ];

    const { strains } = buildInventoryMatrix(skus);
    expect(strains).toEqual(['Aloha Sugar', 'Bacio Gelato', 'Cake Runtz']);
  });

  it('fills N/A cells for strain x format combos with no matching SKU', () => {
    const skus: SKUStatus[] = [
      makeSku({ sku: 'AS-VAR-8', strainName: 'Aloha Sugar', format: 'Variety' }),
    ];

    const { cells } = buildInventoryMatrix(skus);
    const row = cells.get('Aloha Sugar')!;
    expect(row.get('Variety')).toEqual({ kind: 'sku', sku: skus[0] });
    expect(row.get('Eighth')).toEqual({ kind: 'na' });
    expect(row.get('Half')).toEqual({ kind: 'na' });
    expect(row.get('Bites')).toEqual({ kind: 'na' });
    expect(Array.from(row.keys()).sort()).toEqual([...FORMAT_COLUMNS].sort());
  });

  it('routes SKUs with format "Other" or no strain into otherSkus instead of dropping them', () => {
    const skus: SKUStatus[] = [
      makeSku({ sku: 'MISC-1', strainName: 'MAC1', format: 'Other' }),
      makeSku({ sku: 'MISC-2', format: 'Eighth' }), // no strainName
    ];

    const { strains, otherSkus } = buildInventoryMatrix(skus);
    expect(strains).toEqual([]);
    expect(otherSkus.map(s => s.sku)).toEqual(['MISC-1', 'MISC-2']);
  });
});

describe('getAttentionItems', () => {
  it('orders short before restage before low, then alphabetically by SKU', () => {
    const skus: SKUStatus[] = [
      makeSku({ sku: 'ZZ-LOW', state: 'low' }),
      makeSku({ sku: 'AA-SHORT', state: 'short', gap: 2 }),
      makeSku({ sku: 'BB-RESTAGE', state: 'restage', pending: 3 }),
      makeSku({ sku: 'AA-LOW', state: 'low' }),
      makeSku({ sku: 'CC-OK', state: 'ok' }),
      makeSku({ sku: 'DD-IDLE', state: 'idle' }),
    ];

    const items = getAttentionItems(skus);
    expect(items.map(i => i.sku.sku)).toEqual(['AA-SHORT', 'BB-RESTAGE', 'AA-LOW', 'ZZ-LOW']);
  });

  it('excludes ok and idle states', () => {
    const skus: SKUStatus[] = [
      makeSku({ sku: 'OK-1', state: 'ok' }),
      makeSku({ sku: 'IDLE-1', state: 'idle' }),
    ];

    expect(getAttentionItems(skus)).toEqual([]);
  });
});
