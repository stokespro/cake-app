-- Migration: Guarantee every SKU has an inventory row (SPRO-131)
-- Description: Backfills the missing public.inventory rows and adds a trigger so
--              a SKU can never again exist without one.
--
-- WHY THIS EXISTS
--   Nothing has ever created inventory rows. The rows that exist came from the
--   original vault-inventory seed; every SKU created through the app since then
--   has had none. That was invisible on read — lib/packaging/db.ts readInventory()
--   seeds all active SKUs with {0,0,0} in memory, so the board rendered them fine
--   — but fatal on write, because every packaging write path was
--
--       UPDATE inventory SET staged = $1 WHERE sku_id = $2
--
--   and an UPDATE that matches zero rows is not an error in Postgres. PostgREST
--   returned success, the inventory_log row was written anyway, and the UI toasted
--   "Added 8 to AS staged" for a write that touched nothing. Aloha Sugar was
--   staged three times on 2026-08-25 and never moved off 0.
--
--   The application-side fix (upsert + row-count assertions) landed alongside this
--   migration and is what actually unblocks staging. This migration is the
--   schema-level guarantee: it repairs the 18 SKUs already in that state and makes
--   the invariant structural rather than something every future write path has to
--   remember.
--
-- SAFETY
--   Purely additive. Inserts all-zero rows only where none exists — no existing
--   count is read, changed, or overwritten. Re-runnable.
--
--   Inserting these rows fires the existing trg_inventory_refresh_in_stock, which
--   recomputes skus.in_stock via refresh_sku_in_stock_by_id() (see
--   20260616000100_derive_sku_in_stock.sql). That is intended: those SKUs have been
--   carrying an in_stock value that was never derived from a real inventory row.
--   The formula counts vault weight as well as staged/filled/cased, so a SKU backed
--   by vault packages stays in stock; one backed by nothing becomes false, which is
--   the truthful answer.

BEGIN;

-- 1. Backfill: one all-zero row per SKU that lacks one.
INSERT INTO public.inventory (sku_id, cased, filled, staged)
SELECT s.id, 0, 0, 0
  FROM public.skus s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.inventory i WHERE i.sku_id = s.id
 );

-- 2. Trigger function: every new SKU gets its inventory row immediately.
--    ON CONFLICT DO NOTHING keeps this compatible with actions/products.ts,
--    which also inserts the row (harmlessly, and so that preview/production
--    behaviour matches before and after this migration is applied).
CREATE OR REPLACE FUNCTION public.trg_skus_ensure_inventory_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.inventory (sku_id, cased, filled, staged)
  VALUES (NEW.id, 0, 0, 0)
  ON CONFLICT (sku_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_skus_ensure_inventory_row() IS
'Creates the all-zero public.inventory row for a newly inserted SKU. Guarantees the invariant that every SKU has exactly one inventory row, which the packaging write paths depend on (SPRO-131).';

DROP TRIGGER IF EXISTS trg_skus_ensure_inventory_row ON public.skus;
CREATE TRIGGER trg_skus_ensure_inventory_row
  AFTER INSERT ON public.skus
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_skus_ensure_inventory_row();

COMMIT;
