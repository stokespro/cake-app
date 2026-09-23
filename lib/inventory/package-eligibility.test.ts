// SPRO-150: available inventory must exclude sub-threshold vault packages.
//
// The boundary cases are the whole point of the ticket, so each threshold is
// pinned at below / exactly-at / above, and the "two 56 g packages are not a
// case" scenario is asserted through filterEligiblePackages() — the function
// both call sites (actions/inventory.ts, actions/customers.ts) actually use —
// rather than only through the predicate.
//
// Follows the house style of lib/orders/deductions.test.ts.

import { describe, expect, it } from 'vitest';
import {
  A_BUDS_PRODUCT_TYPE,
  BITES_PRODUCT_TYPE,
  MIN_PACKAGE_GRAMS,
  filterEligiblePackages,
  getMinimumPackageGrams,
  isPackageEligible,
} from './package-eligibility';

const A_BUDS_TYPE_ID = 'type-a-buds';
const BITES_TYPE_ID = 'type-bites';
const SHAKE_TYPE_ID = 'type-shake';

const TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  [A_BUDS_TYPE_ID, A_BUDS_PRODUCT_TYPE],
  [BITES_TYPE_ID, BITES_PRODUCT_TYPE],
  [SHAKE_TYPE_ID, 'Shake'],
]);

/** Sum the weight that survives filtering — what an availability aggregation sees. */
function eligibleGrams(
  packages: { type_id: string; current_weight: number }[]
): number {
  return filterEligiblePackages(packages, TYPE_NAMES).reduce(
    (total, pkg) => total + pkg.current_weight,
    0
  );
}

describe('MIN_PACKAGE_GRAMS', () => {
  it('is the SPRO-150 rule: A Buds 112 g, Bites 224 g, nothing else', () => {
    expect(MIN_PACKAGE_GRAMS).toEqual({ 'A Buds': 112, Bites: 224 });
  });
});

describe('getMinimumPackageGrams', () => {
  it('returns the threshold for each target type', () => {
    expect(getMinimumPackageGrams('A Buds')).toBe(112);
    expect(getMinimumPackageGrams('Bites')).toBe(224);
  });

  it('returns null for non-target, unknown and missing types', () => {
    expect(getMinimumPackageGrams('Shake')).toBeNull();
    expect(getMinimumPackageGrams('Trim')).toBeNull();
    expect(getMinimumPackageGrams('Mystery Type')).toBeNull();
    expect(getMinimumPackageGrams('')).toBeNull();
    expect(getMinimumPackageGrams(null)).toBeNull();
    expect(getMinimumPackageGrams(undefined)).toBeNull();
  });

  it('does not treat inherited Object properties as product types', () => {
    expect(getMinimumPackageGrams('toString')).toBeNull();
    expect(getMinimumPackageGrams('constructor')).toBeNull();
  });

  it('ignores surrounding whitespace, like deriveFormat does', () => {
    expect(getMinimumPackageGrams('  A Buds ')).toBe(112);
  });
});

describe('isPackageEligible — A Buds boundary at 112 g', () => {
  it('excludes a package below the threshold', () => {
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 111.99)).toBe(false);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 56)).toBe(false);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 0)).toBe(false);
  });

  it('includes a package exactly at the threshold', () => {
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 112)).toBe(true);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, '112.00')).toBe(true);
  });

  it('includes a package above the threshold', () => {
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 112.01)).toBe(true);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 5000)).toBe(true);
  });
});

describe('isPackageEligible — Bites boundary at 224 g', () => {
  it('excludes a package below the threshold', () => {
    expect(isPackageEligible(BITES_PRODUCT_TYPE, 223.99)).toBe(false);
    expect(isPackageEligible(BITES_PRODUCT_TYPE, 112)).toBe(false);
  });

  it('includes a package exactly at the threshold', () => {
    expect(isPackageEligible(BITES_PRODUCT_TYPE, 224)).toBe(true);
    expect(isPackageEligible(BITES_PRODUCT_TYPE, '224.00')).toBe(true);
  });

  it('includes a package above the threshold', () => {
    expect(isPackageEligible(BITES_PRODUCT_TYPE, 224.01)).toBe(true);
    expect(isPackageEligible(BITES_PRODUCT_TYPE, 448)).toBe(true);
  });
});

describe('isPackageEligible — non-target types are unchanged', () => {
  it('counts a non-target package at any weight, including under 112 g', () => {
    expect(isPackageEligible('Shake', 1)).toBe(true);
    expect(isPackageEligible('Trim', 56)).toBe(true);
    expect(isPackageEligible('Shake', 0)).toBe(true);
  });

  it('counts a package whose type name is unknown or unresolvable', () => {
    expect(isPackageEligible('Mystery Type', 1)).toBe(true);
    expect(isPackageEligible(null, 1)).toBe(true);
    expect(isPackageEligible(undefined, 1)).toBe(true);
  });

  it('never excludes a non-target package for an unreadable weight', () => {
    expect(isPackageEligible('Shake', null)).toBe(true);
    expect(isPackageEligible('Shake', 'not a number')).toBe(true);
  });

  it('excludes a target package whose weight is unreadable', () => {
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, null)).toBe(false);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, undefined)).toBe(false);
    expect(isPackageEligible(A_BUDS_PRODUCT_TYPE, 'not a number')).toBe(false);
  });
});

describe('filterEligiblePackages', () => {
  it('cannot combine two independent 56 g A Buds packages into a 112 g case', () => {
    const packages = [
      { type_id: A_BUDS_TYPE_ID, current_weight: 56 },
      { type_id: A_BUDS_TYPE_ID, current_weight: 56 },
    ];

    expect(filterEligiblePackages(packages, TYPE_NAMES)).toEqual([]);
    expect(eligibleGrams(packages)).toBe(0);
  });

  it('cannot combine two 112 g Bites packages into a 224 g case', () => {
    const packages = [
      { type_id: BITES_TYPE_ID, current_weight: 112 },
      { type_id: BITES_TYPE_ID, current_weight: 112 },
    ];

    expect(eligibleGrams(packages)).toBe(0);
  });

  it('keeps a qualifying package at its complete weight, not truncated to the threshold', () => {
    expect(eligibleGrams([{ type_id: A_BUDS_TYPE_ID, current_weight: 150 }])).toBe(150);
    expect(eligibleGrams([{ type_id: BITES_TYPE_ID, current_weight: 300 }])).toBe(300);
  });

  it('drops only the sub-threshold packages from a mixed vault', () => {
    const packages = [
      { type_id: A_BUDS_TYPE_ID, current_weight: 56 },
      { type_id: A_BUDS_TYPE_ID, current_weight: 112 },
      { type_id: A_BUDS_TYPE_ID, current_weight: 200 },
      { type_id: BITES_TYPE_ID, current_weight: 223 },
      { type_id: BITES_TYPE_ID, current_weight: 224 },
      { type_id: SHAKE_TYPE_ID, current_weight: 10 },
    ];

    expect(filterEligiblePackages(packages, TYPE_NAMES)).toEqual([
      { type_id: A_BUDS_TYPE_ID, current_weight: 112 },
      { type_id: A_BUDS_TYPE_ID, current_weight: 200 },
      { type_id: BITES_TYPE_ID, current_weight: 224 },
      { type_id: SHAKE_TYPE_ID, current_weight: 10 },
    ]);
    expect(eligibleGrams(packages)).toBe(546);
  });

  it('keeps a package whose type_id is not in the name map', () => {
    const packages = [{ type_id: 'type-deleted', current_weight: 5 }];

    expect(eligibleGrams(packages)).toBe(5);
  });

  it('returns a new array and leaves the input untouched', () => {
    const packages = [{ type_id: A_BUDS_TYPE_ID, current_weight: 56 }];
    const result = filterEligiblePackages(packages, TYPE_NAMES);

    expect(result).not.toBe(packages);
    expect(packages).toHaveLength(1);
  });
});
