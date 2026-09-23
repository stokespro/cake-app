// SPRO-150: per-package eligibility for the "available inventory" calculation.
//
// No imports, no I/O, no browser or Node globals — safe to import from
// 'use server' action files (actions/inventory.ts, actions/customers.ts), from
// client components and from tests without a database. Same shape as
// lib/orders/deductions.ts.
//
// THE BUG THIS FIXES: availability summed every active vault package for a
// strain+type and only then divided by grams-per-case. Two half-full packages
// therefore reported a whole case, but a package is a physical sealed
// container — material in two of them cannot be merged to fill one case. The
// fix is to decide eligibility PER PACKAGE, before any aggregation.
//
// Thresholds are the product/ops rule from SPRO-150, not a formula: they are
// NOT derived from skus.grams_per_unit * skus.units_per_case (live A Buds SKUs
// alone span 28 g, 112 g, 224 g and 448 g cases). Do not "simplify" them into
// a lookup against the SKU.
//
//   'A Buds' -> 112 g
//   'Bites'  -> 224 g
//
// Every other product type ('Shake', 'Trim', and any unknown or missing name)
// is deliberately untouched and keeps the pre-SPRO-150 behaviour of counting
// in full at any weight.
//
// This file is a lockstep mirror of the per-package eligibility predicate in
// supabase/migrations/20260923120000_exclude_subthreshold_packages_from_in_stock.sql
// — keep the two in sync EXACTLY. The DB is the authority for skus.in_stock;
// these functions exist so the dashboard and the sales availability list can
// apply the same rule without a round trip.

/** Product type name whose packages must hold at least 112 g to count. */
export const A_BUDS_PRODUCT_TYPE = 'A Buds';

/** Product type name whose packages must hold at least 224 g to count. */
export const BITES_PRODUCT_TYPE = 'Bites';

/**
 * Minimum grams a single package must hold, by product type name.
 * A type absent from this map has no minimum — see module comment.
 */
export const MIN_PACKAGE_GRAMS: Readonly<Record<string, number>> = {
  [A_BUDS_PRODUCT_TYPE]: 112,
  [BITES_PRODUCT_TYPE]: 224,
};

/** The vault-package fields eligibility depends on. */
export interface EligibilityPackage {
  type_id: string;
  current_weight: number | string | null;
}

/**
 * Minimum grams for a product type name, or null when the type has no minimum
 * (every non-target type, including unknown and missing names).
 */
export function getMinimumPackageGrams(
  productTypeName: string | null | undefined
): number | null {
  const type = (productTypeName || '').trim();
  return Object.prototype.hasOwnProperty.call(MIN_PACKAGE_GRAMS, type)
    ? MIN_PACKAGE_GRAMS[type]
    : null;
}

/**
 * Does this single package count toward available inventory?
 *
 * Non-target product types always count (unchanged behaviour). A target type
 * counts only at or above its threshold, and then contributes its COMPLETE
 * weight — the caller keeps summing eligible packages exactly as before.
 *
 * packages.current_weight is numeric(10,2) NOT NULL, so `>=` is an exact
 * decimal comparison and matches the SQL predicate with no epsilon. The
 * string branch only guards against a driver handing back the numeric as a
 * string, the way lib/packaging/allocation-engine.ts does for grams_per_unit.
 * A weight that is not a finite number cannot be shown to clear a threshold,
 * so it is excluded.
 */
export function isPackageEligible(
  productTypeName: string | null | undefined,
  currentWeight: number | string | null | undefined
): boolean {
  const minimum = getMinimumPackageGrams(productTypeName);
  if (minimum === null) return true;

  const grams = Number(currentWeight);
  if (!Number.isFinite(grams)) return false;

  return grams >= minimum;
}

/**
 * Drop the packages that must not reach an availability aggregation.
 *
 * `productTypeNameById` maps product_types.id -> product_types.name; an id
 * missing from it resolves to no minimum, so an unresolvable type is kept
 * rather than silently zeroed out.
 */
export function filterEligiblePackages<T extends EligibilityPackage>(
  packages: readonly T[],
  productTypeNameById: ReadonlyMap<string, string>
): T[] {
  return packages.filter((pkg) =>
    isPackageEligible(productTypeNameById.get(pkg.type_id), pkg.current_weight)
  );
}
