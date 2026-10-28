-- SPRO-235: keep packages.batch / strain_id / strain in sync with the package's batch.
--
-- packages.batch_id (20261029100000) is the source of truth. The copied columns stay because
-- many readers use them (inventory, customers, refresh_sku_in_stock_by_id, vault pages).
--
--  * trg_packages_sync_from_batch   BEFORE INSERT/UPDATE on packages: derive copies from the batch.
--      Legacy text-only writers (batch_id NULL, or batch text edited alone) still work: batch_id is
--      resolved by exact name. A batch with no strain is rejected.
--  * trg_batches_push_to_packages   AFTER UPDATE OF name, strain_id on batches: push to packages.
--      Cascade: batches AFTER -> packages UPDATE -> packages BEFORE sync (idempotent, re-derives the
--      same values) -> packages AFTER trg_packages_refresh_in_stock (refreshes old+new SKUs on
--      strain_id change). Nothing here writes back to batches, so it is not recursive.
--  * trg_strains_push_name_to_packages  AFTER UPDATE OF name on strains: refresh packages.strain text.
--      (UPDATE OF strain does not fire the sync or in_stock triggers.)
--  * trg_packages_refresh_in_stock is recreated with batch_id added to its UPDATE OF list
--      (same function as 20261028120000).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_packages_sync_from_batch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_id     uuid := NEW.batch_id;
  v_name   text;
  v_strain uuid;
  v_sname  text;
BEGIN
  IF v_id IS NULL
     OR (TG_OP = 'UPDATE'
         AND NEW.batch_id IS NOT DISTINCT FROM OLD.batch_id
         AND NEW.batch    IS DISTINCT FROM OLD.batch)
  THEN
    -- text-driven write: resolve by exact name
    SELECT id INTO v_id FROM public.batches WHERE name = NEW.batch;
    IF v_id IS NULL THEN
      IF NEW.batch_id IS NULL THEN
        RETURN NEW; -- legacy row with no resolvable batch
      END IF;
      RAISE EXCEPTION 'Batch "%" not found', NEW.batch;
    END IF;
  END IF;

  SELECT b.name, b.strain_id, s.name
    INTO v_name, v_strain, v_sname
    FROM public.batches b
    LEFT JOIN public.strains s ON s.id = b.strain_id
   WHERE b.id = v_id;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Batch % not found', v_id;
  END IF;
  IF v_strain IS NULL OR v_sname IS NULL THEN
    RAISE EXCEPTION 'Batch "%" has no strain assigned', v_name;
  END IF;

  NEW.batch_id  := v_id;
  NEW.batch     := v_name;
  NEW.strain_id := v_strain;
  NEW.strain    := v_sname;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_packages_sync_from_batch ON public.packages;
CREATE TRIGGER trg_packages_sync_from_batch
  BEFORE INSERT OR UPDATE OF batch, batch_id ON public.packages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_packages_sync_from_batch();

CREATE OR REPLACE FUNCTION public.trg_batches_push_to_packages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sname text;
BEGIN
  IF NEW.strain_id IS NULL THEN
    -- packages.strain is NOT NULL and the sync trigger refuses strainless batches, so a batch
    -- that has packages must keep a strain.
    IF EXISTS (SELECT 1 FROM public.packages WHERE batch_id = NEW.id) THEN
      RAISE EXCEPTION 'Batch "%" has packages and must keep a strain', NEW.name;
    END IF;
    RETURN NEW;
  END IF;

  SELECT name INTO v_sname FROM public.strains WHERE id = NEW.strain_id;

  UPDATE public.packages
     SET batch     = NEW.name,
         strain_id = NEW.strain_id,
         strain    = v_sname
   WHERE batch_id = NEW.id
     AND (batch     IS DISTINCT FROM NEW.name
       OR strain_id IS DISTINCT FROM NEW.strain_id
       OR strain    IS DISTINCT FROM v_sname);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_batches_push_to_packages ON public.batches;
CREATE TRIGGER trg_batches_push_to_packages
  AFTER UPDATE OF name, strain_id ON public.batches
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_batches_push_to_packages();

CREATE OR REPLACE FUNCTION public.trg_strains_push_name_to_packages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.packages
     SET strain = NEW.name
   WHERE strain_id = NEW.id
     AND strain IS DISTINCT FROM NEW.name;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_strains_push_name_to_packages ON public.strains;
CREATE TRIGGER trg_strains_push_name_to_packages
  AFTER UPDATE OF name ON public.strains
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_strains_push_name_to_packages();

-- Same function as 20261028120000; only the column list gains batch_id.
DROP TRIGGER IF EXISTS trg_packages_refresh_in_stock ON public.packages;
CREATE TRIGGER trg_packages_refresh_in_stock
  AFTER INSERT OR DELETE OR UPDATE OF current_weight, is_active, strain_id, type_id, batch_id ON public.packages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_packages_refresh_in_stock();

-- One-time resync of any drifted rows (expected 0). Fires the sync trigger via batch_id.
UPDATE public.packages p
   SET batch_id = p.batch_id
 WHERE p.batch_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM public.batches b
       JOIN public.strains s ON s.id = b.strain_id
      WHERE b.id = p.batch_id
        AND (p.batch IS DISTINCT FROM b.name
          OR p.strain_id IS DISTINCT FROM b.strain_id
          OR p.strain IS DISTINCT FROM s.name)
   );

COMMIT;
