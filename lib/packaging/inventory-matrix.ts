// Pure grouping/sorting logic for the SPRO-128 strain x format inventory
// matrix. Kept dependency-free (no React) so it's cheap to unit test and
// reusable between the desktop table and mobile per-strain card layouts.

import type { SKUStatus, InventoryCellState } from './types';

// Fixed column order — never re-sorted, never data-driven. Row/column
// stability across realtime refresh is the core promise of this redesign.
export const FORMAT_COLUMNS = ['Eighth', 'Half', 'Bites', 'Variety'] as const;
export type FormatColumn = (typeof FORMAT_COLUMNS)[number];

export type MatrixCell =
  | { kind: 'na' } // No SKU exists for this strain x format combo (structural — e.g. Aloha Sugar has no Eighth)
  | { kind: 'inactive' } // SKU exists in the DB but status !== 'active'.
  // NOTE: nothing in the current data path can produce this today — db.ts's
  // loadSkuMappings() filters to status='active' only (a deliberate,
  // unchanged scoping decision for SPRO-128; see the PR report). This
  // variant/render path exists so the UI is ready once that filter question
  // is resolved, not because it's reachable right now.
  | { kind: 'sku'; sku: SKUStatus };

export interface InventoryMatrixData {
  strains: string[];
  cells: Map<string, Map<FormatColumn, MatrixCell>>;
  // SKUs whose format is 'Other', or which have no strain, still need to be
  // rendered somewhere — silently vanishing inventory is worse than an ugly
  // row. These are never placed in the matrix grid.
  otherSkus: SKUStatus[];
}

function isFormatColumn(format: string | undefined): format is FormatColumn {
  return !!format && (FORMAT_COLUMNS as readonly string[]).includes(format);
}

// Groups enriched SKU status rows into a strain x format matrix. Rows
// (strains) are every distinct strainName among SKUs with a recognized
// format, sorted alphabetically — fixed order regardless of DB/load order.
export function buildInventoryMatrix(skus: SKUStatus[]): InventoryMatrixData {
  const strainSet = new Set<string>();
  const cells = new Map<string, Map<FormatColumn, MatrixCell>>();
  const otherSkus: SKUStatus[] = [];

  for (const sku of skus) {
    if (!sku.strainName || !isFormatColumn(sku.format)) {
      otherSkus.push(sku);
      continue;
    }

    strainSet.add(sku.strainName);
    if (!cells.has(sku.strainName)) {
      cells.set(sku.strainName, new Map());
    }
    cells.get(sku.strainName)!.set(sku.format, { kind: 'sku', sku });
  }

  const strains = Array.from(strainSet).sort((a, b) => a.localeCompare(b));

  // Fill N/A for every strain x format combo with no matching active SKU.
  for (const strain of strains) {
    const row = cells.get(strain)!;
    for (const format of FORMAT_COLUMNS) {
      if (!row.has(format)) {
        row.set(format, { kind: 'na' });
      }
    }
  }

  otherSkus.sort((a, b) => a.sku.localeCompare(b.sku));

  return { strains, cells, otherSkus };
}

export interface AttentionItem {
  sku: SKUStatus;
  severity: 0 | 1 | 2;
}

type AttentionState = 'short' | 'restage' | 'low';

const SEVERITY_RANK: Record<AttentionState, 0 | 1 | 2> = {
  short: 0,
  restage: 1,
  low: 2,
};

function isAttentionState(state: InventoryCellState): state is AttentionState {
  return state === 'short' || state === 'restage' || state === 'low';
}

// Every SKU whose state warrants attention (short/restage/low), worst-first,
// then alphabetical by SKU code. Independent of the matrix layout — includes
// SKUs in the "Other" bucket too, since the strip is a safety net, not a
// view of the grid.
export function getAttentionItems(skus: SKUStatus[]): AttentionItem[] {
  return skus
    .filter((sku): sku is SKUStatus & { state: AttentionState } => isAttentionState(sku.state))
    .map(sku => ({ sku, severity: SEVERITY_RANK[sku.state] }))
    .sort((a, b) => a.severity - b.severity || a.sku.sku.localeCompare(b.sku.sku));
}
