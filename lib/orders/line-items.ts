// SPRO-148: the one place that turns persisted order_items into the shape the
// order forms edit, and the one definition of the units-per-case fallback.
//
// No imports beyond the sibling money helpers, no I/O — safe to import from
// 'use server' action files, from 'use client' components and from tests
// without a database, same as lib/orders/deductions.ts.
//
// The house pricing rule, shared by every order surface, is
//   line_total = cases x units_per_case x unit_price
// where the DB stores CASES in order_items.quantity (not units) and
// units_per_case lives on the SKU. actions/orders.ts redoes that
// multiplication server-side on every write; this module is the read side of
// the same rule, so the form preview and the persisted amount agree.

import { roundCurrency } from './deductions'

/**
 * Fallback units-per-case. `skus.units_per_case` is NOT NULL DEFAULT 32 in the
 * database, so this only ever guards a SKU that could not be resolved at all.
 */
export const DEFAULT_UNITS_PER_CASE = 32

/** Enough of a SKU to price and label a line — satisfied by OrderSkuRecord. */
export interface LineItemSku {
  id: string
  code?: string | null
  name?: string | null
  units_per_case?: number | null
}

/** An order_items row as the read actions return it, with its joined SKU. */
export interface PersistedOrderItem {
  sku_id: string
  /** CASES — the DB column is named quantity but stores cases. */
  quantity: number
  unit_price?: number | null
  sku?: { code?: string | null; name?: string | null; units_per_case?: number | null } | null
}

/** A line as the order forms hold it while editing. */
export interface OrderFormLineItem {
  sku_id: string
  sku_code: string
  sku_name: string
  cases: number
  units_per_case: number
  /** Total UNITS (cases x units_per_case) — what the unit price multiplies. */
  quantity: number
  unit_price: number | null
  line_total: number
}

/**
 * Maps persisted order items onto form lines for an edit.
 *
 * SKU details are taken from the picker list when the SKU is in it, and fall
 * back to the SKU joined onto the order item otherwise — an order can contain
 * a SKU that has since gone out of stock or inactive and so is missing from
 * the picker, and such a line must still render with its real name and its
 * real units_per_case rather than silently repricing against the 32 default.
 *
 * `priceForSku` supplies the customer-pricing lookup for a line that was
 * persisted without a unit price; a line that has one keeps it.
 */
export function mapOrderItemsToForm(
  items: readonly PersistedOrderItem[] | null | undefined,
  skus: readonly LineItemSku[] | null | undefined,
  priceForSku: (skuId: string) => number | null
): OrderFormLineItem[] {
  const list = skus ?? []

  return (items ?? []).map(item => {
    const picked = list.find(sku => sku.id === item.sku_id)
    const joined = item.sku ?? null

    const unitsPerCase =
      picked?.units_per_case || joined?.units_per_case || DEFAULT_UNITS_PER_CASE
    const cases = item.quantity
    const quantity = cases * unitsPerCase
    const unitPrice = item.unit_price ?? priceForSku(item.sku_id)

    return {
      sku_id: item.sku_id,
      sku_code: picked?.code || joined?.code || '',
      sku_name: picked?.name || joined?.name || 'Unknown SKU',
      cases,
      units_per_case: unitsPerCase,
      quantity,
      unit_price: unitPrice,
      line_total: unitPrice !== null ? roundCurrency(quantity * unitPrice) : 0,
    }
  })
}

/** Enough of a SKU to decide whether a new line may default to it. */
export interface OrderableSku {
  id: string
  in_stock?: boolean | null
}

/**
 * The first SKU a brand-new order line may default to, or null if there is none.
 *
 * SPRO-151: the order pickers deliberately LIST out-of-stock SKUs — greyed out,
 * labelled "Out of Stock" and unselectable — so the first entry of the picker
 * list is not necessarily orderable, and a line defaulted to it would only be
 * rejected by the server availability gate in actions/orders.ts. Every default
 * and every "Add Item" enablement decision goes through this instead.
 */
export function firstOrderableSku<T extends OrderableSku>(
  skus: readonly T[] | null | undefined
): T | null {
  return (skus ?? []).find(sku => sku.in_stock === true) ?? null
}
