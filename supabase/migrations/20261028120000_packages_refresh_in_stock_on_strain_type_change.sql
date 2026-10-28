-- SPRO-234: refresh skus.in_stock when a package's strain_id or type_id changes.
--
-- Previously the trigger fired only on UPDATE OF current_weight, is_active, and the
-- function only refreshed SKUs for COALESCE(NEW, OLD) -- so re-assigning a package to a
-- different strain/type left both the old and new SKUs stale.
--
-- The function now refreshes SKUs for BOTH the OLD and NEW (strain_id, type_id) pairs on
-- UPDATE, only NEW on INSERT, and only OLD on DELETE.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_packages_refresh_in_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sku record;
BEGIN
  -- NEW side (INSERT / UPDATE)
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.strain_id IS NOT NULL THEN
    FOR v_sku IN
      SELECT id FROM public.skus
       WHERE strain_id       = NEW.strain_id
         AND product_type_id = NEW.type_id
    LOOP
      PERFORM public.refresh_sku_in_stock_by_id(v_sku.id);
    END LOOP;
  END IF;

  -- OLD side (DELETE / UPDATE). Skip on UPDATE when the pair is unchanged: NEW pass above
  -- already covered it.
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD.strain_id IS NOT NULL
     AND NOT (
       TG_OP = 'UPDATE'
       AND OLD.strain_id IS NOT DISTINCT FROM NEW.strain_id
       AND OLD.type_id   IS NOT DISTINCT FROM NEW.type_id
     )
  THEN
    FOR v_sku IN
      SELECT id FROM public.skus
       WHERE strain_id       = OLD.strain_id
         AND product_type_id = OLD.type_id
    LOOP
      PERFORM public.refresh_sku_in_stock_by_id(v_sku.id);
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_packages_refresh_in_stock ON public.packages;
CREATE TRIGGER trg_packages_refresh_in_stock
  AFTER INSERT OR DELETE OR UPDATE OF current_weight, is_active, strain_id, type_id ON public.packages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_packages_refresh_in_stock();

COMMIT;
