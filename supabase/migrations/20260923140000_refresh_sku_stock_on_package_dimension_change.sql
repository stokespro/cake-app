-- SPRO-151: recompute derived SKU stock when a package is reassigned to a
-- different strain or product type.
--
-- Bug: trg_packages_refresh_in_stock was attached as
--   AFTER INSERT OR UPDATE OF current_weight, is_active OR DELETE
-- and its function resolved ONE strain+type pair with
--   COALESCE(NEW.strain_id, OLD.strain_id) / COALESCE(NEW.type_id, OLD.type_id).
--
-- Two gaps followed, and both leave skus.in_stock stale rather than wrong-by-
-- formula, which is why the symptom was SKU-specific (an out-of-stock MAC-B
-- still reading in_stock = true while BB-B read false) with no SKU or
-- product-type branching anywhere in the code:
--
--   1. Reassigning a package's strain_id or type_id did not fire the trigger at
--      all. The weight silently left one strain+type bucket and joined another;
--      neither side's SKUs were recomputed.
--   2. Even when the trigger did fire on an UPDATE, COALESCE takes NEW first,
--      so only the NEW association was refreshed. The SKUs the package used to
--      back kept counting weight that had moved away.
--
-- Fix: fire on strain_id and type_id as well, and refresh BOTH associations on
-- UPDATE — NEW on INSERT, OLD on DELETE, OLD and NEW on UPDATE. The side that
-- does not exist for a given event is left NULL via TG_OP and dropped by the
-- WHERE strain_id IS NOT NULL filter, which also preserves the previous
-- early-return for legacy packages that carry no strain_id at all.
--
-- The availability formula itself is untouched: this migration does not
-- redefine public.refresh_sku_in_stock_by_id (still the SPRO-150 version with
-- the per-package minimums), it only changes WHICH SKUs get recomputed and
-- WHEN. The SKU match stays plain equality on strain_id + product_type_id,
-- exactly as refresh_sku_in_stock_by_id sums packages, so a NULL type_id keeps
-- matching nothing rather than newly matching NULL-typed SKUs.

CREATE OR REPLACE FUNCTION public.trg_packages_refresh_in_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old_strain_id uuid;
  v_old_type_id   uuid;
  v_new_strain_id uuid;
  v_new_type_id   uuid;
  v_sku           record;
BEGIN
  -- Capture each side only where the trigger event actually provides it, so
  -- the record that does not exist for this event is never dereferenced.
  IF TG_OP <> 'INSERT' THEN
    v_old_strain_id := OLD.strain_id;
    v_old_type_id   := OLD.type_id;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_strain_id := NEW.strain_id;
    v_new_type_id   := NEW.type_id;
  END IF;

  -- One package can back several SKU variants (e.g. 1g/3.5g/7g/14g of the same
  -- strain+type), and an UPDATE can move it between two different strain+type
  -- buckets, so this is a set of SKUs across up to two associations — not one.
  -- DISTINCT collapses the common case where both sides are the same bucket
  -- (a plain current_weight or is_active edit).
  FOR v_sku IN
    SELECT DISTINCT s.id
      FROM (VALUES
              (v_old_strain_id, v_old_type_id),
              (v_new_strain_id, v_new_type_id)
           ) AS dims(strain_id, type_id)
      JOIN public.skus s
        ON s.strain_id       = dims.strain_id
       AND s.product_type_id = dims.type_id
     WHERE dims.strain_id IS NOT NULL
  LOOP
    PERFORM public.refresh_sku_in_stock_by_id(v_sku.id);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.trg_packages_refresh_in_stock() IS
'Refreshes skus.in_stock for every SKU matching the package''s strain+product type. SPRO-151: on UPDATE it refreshes BOTH the old and the new association, so reassigning strain_id or type_id cannot leave the previous SKUs holding stale weight.';

-- Recreate the trigger so strain_id / type_id reassignment actually fires it.
DROP TRIGGER IF EXISTS trg_packages_refresh_in_stock ON public.packages;
CREATE TRIGGER trg_packages_refresh_in_stock
  AFTER INSERT OR DELETE OR UPDATE OF current_weight, is_active, strain_id, type_id
  ON public.packages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_packages_refresh_in_stock();

-- Backfill every SKU: rows that went stale while the trigger was blind to
-- reassignment must be corrected now, not on the next unrelated weight edit.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.skus LOOP
    PERFORM public.refresh_sku_in_stock_by_id(r.id);
  END LOOP;
END;
$$;
