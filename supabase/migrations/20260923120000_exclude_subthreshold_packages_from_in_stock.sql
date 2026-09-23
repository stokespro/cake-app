-- SPRO-150: exclude sub-threshold vault packages from derived availability.
--
-- Bug: refresh_sku_in_stock_by_id() summed EVERY active package for the SKU's
-- strain+type and only then divided by grams-per-case. Two half-full packages
-- therefore derived a whole case and flipped in_stock to true, but a package is
-- a physical sealed container — material in two of them cannot be merged to
-- fill one case. Eligibility must be decided PER PACKAGE, before the SUM.
--
-- Rule (mirrored in lib/inventory/package-eligibility.ts — keep the two in sync
-- EXACTLY): a single package counts only at or above the minimum for its
-- product type, and a qualifying package then contributes its COMPLETE weight.
--   'A Buds' -> 112 g
--   'Bites'  -> 224 g
-- Every other product type ('Shake', 'Trim', an unknown name, or a package
-- whose type row is missing) has no minimum and keeps its previous behaviour of
-- counting in full at any weight.
--
-- The thresholds are the product/ops rule from SPRO-150. They are NOT derived
-- from skus.grams_per_unit * skus.units_per_case — live A Buds SKUs alone span
-- 28 g, 112 g, 224 g and 448 g cases — so do not "simplify" them into a lookup
-- against the SKU.
--
-- Everything else in this function is carried over verbatim: signature,
-- SECURITY DEFINER + search_path, the non-active SKU guard, the
-- staged/filled/cased terms, and the NULLIF/COALESCE divide-by-zero and
-- NULL safeguards. The triggers on inventory, packages and skus call this
-- function by name and are deliberately left untouched.
--
-- Formula after this migration:
--   vaultCases = FLOOR( SUM(active packages.current_weight
--                           WHERE packages.strain_id = sku.strain_id
--                             AND packages.type_id   = sku.product_type_id
--                             AND package clears its product type's minimum)
--                       / (sku.grams_per_unit * sku.units_per_case) )
--   in_stock = (vaultCases + inventory.staged + inventory.filled + inventory.cased) > 0
CREATE OR REPLACE FUNCTION public.refresh_sku_in_stock_by_id(p_sku_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_strain_id         uuid;
  v_product_type_id   uuid;
  v_product_type_name text;
  v_min_package_grams numeric;
  v_grams_per_unit    numeric;
  v_units_per_case    integer;
  v_status            text;
  v_vault_weight      numeric;
  v_vault_cases       bigint;
  v_staged            integer;
  v_filled            integer;
  v_cased             integer;
  v_is_in_stock       boolean;
BEGIN
  SELECT strain_id, product_type_id, grams_per_unit, units_per_case, status
    INTO v_strain_id, v_product_type_id, v_grams_per_unit, v_units_per_case, v_status
    FROM public.skus
   WHERE id = p_sku_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Non-active SKUs are never in stock (not sellable; controls picker visibility)
  IF v_status IS DISTINCT FROM 'active' THEN
    UPDATE public.skus
       SET in_stock = false, updated_at = now()
     WHERE id = p_sku_id;
    RETURN;
  END IF;

  -- SPRO-150: minimum grams a single package must hold to count toward this
  -- SKU's vault weight. Every package summed below shares this SKU's
  -- product_type_id, so the minimum is resolved once rather than per row.
  -- A missing product_types row leaves v_product_type_name NULL, which falls
  -- through to ELSE and imposes no minimum.
  SELECT btrim(name)
    INTO v_product_type_name
    FROM public.product_types
   WHERE id = v_product_type_id;

  v_min_package_grams := CASE v_product_type_name
                           WHEN 'A Buds' THEN 112
                           WHEN 'Bites'  THEN 224
                           ELSE NULL
                         END;

  -- Sum active vault package weights for this strain+type, skipping packages
  -- that are individually too light. NULL minimum = no filter, so non-target
  -- product types sum exactly as they did before.
  SELECT COALESCE(SUM(current_weight), 0)
    INTO v_vault_weight
    FROM public.packages
   WHERE strain_id = v_strain_id
     AND type_id   = v_product_type_id
     AND is_active = true
     AND (v_min_package_grams IS NULL OR current_weight >= v_min_package_grams);

  v_vault_cases := COALESCE(
    FLOOR(v_vault_weight / NULLIF(v_grams_per_unit * v_units_per_case, 0)),
    0
  );

  SELECT COALESCE(staged, 0), COALESCE(filled, 0), COALESCE(cased, 0)
    INTO v_staged, v_filled, v_cased
    FROM public.inventory
   WHERE sku_id = p_sku_id;

  v_staged := COALESCE(v_staged, 0);
  v_filled := COALESCE(v_filled, 0);
  v_cased  := COALESCE(v_cased,  0);

  v_is_in_stock := (v_vault_cases + v_staged + v_filled + v_cased) > 0;

  UPDATE public.skus
     SET in_stock   = v_is_in_stock,
         updated_at = now()
   WHERE id = p_sku_id;
END;
$$;

COMMENT ON FUNCTION public.refresh_sku_in_stock_by_id(uuid) IS
'Recomputes in_stock for a single SKU using vault package weights plus staged/filled/cased inventory. SPRO-150: a package counts toward vault weight only if it individually holds at least 112 g (A Buds) or 224 g (Bites); other product types have no minimum. Called by triggers on inventory, packages and skus.';

-- Backfill: recompute in_stock for EVERY existing SKU so rows that were only
-- in stock through partial target packages drop out immediately, rather than
-- waiting for the next inventory/packages/status change to fire a trigger.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.skus LOOP
    PERFORM public.refresh_sku_in_stock_by_id(r.id);
  END LOOP;
END;
$$;
