-- SPRO-235 SQL smoke test: packages follow their batch (strain change, rename, strain rename, FK).
-- Run only AFTER 20261029100000 and 20261029110000 are applied. One BEGIN ... ROLLBACK block; safe
-- against the live database.
--   psql:        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/packages_batch_sync_smoke.sql
--   execute_sql: paste the whole file as one call.
-- Success: the final result set is 'packages_batch_sync_smoke OK'. Failure raises 'SMOKE FAIL: ...'.
-- Fixtures are picked dynamically: a batch that has packages, and two strains.

BEGIN;

DO $$
DECLARE
  v_batch   uuid;
  v_name    text;
  v_old_s   uuid;
  v_new_s   uuid;
  v_new_sn  text;
  v_pkg     text;
  v_n       int;
  v_bad     int;
  v_type    uuid;
  v_user    uuid;
BEGIN
  SELECT b.id, b.name, b.strain_id INTO v_batch, v_name, v_old_s
    FROM batches b
   WHERE b.strain_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM packages p WHERE p.batch_id = b.id)
   LIMIT 1;
  IF v_batch IS NULL THEN RAISE EXCEPTION 'SMOKE FAIL: no batch with packages to test'; END IF;

  SELECT id, name INTO v_new_s, v_new_sn FROM strains WHERE id <> v_old_s LIMIT 1;
  IF v_new_s IS NULL THEN RAISE EXCEPTION 'SMOKE FAIL: need a second strain'; END IF;

  -- 1) batch strain change propagates
  UPDATE batches SET strain_id = v_new_s WHERE id = v_batch;
  SELECT count(*) INTO v_bad FROM packages
   WHERE batch_id = v_batch AND (strain_id IS DISTINCT FROM v_new_s OR strain IS DISTINCT FROM v_new_sn);
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE FAIL: % packages did not follow batch strain change', v_bad; END IF;

  -- 2) batch rename propagates
  UPDATE batches SET name = v_name || '-ZZSMOKE' WHERE id = v_batch;
  SELECT count(*) INTO v_bad FROM packages WHERE batch_id = v_batch AND batch <> v_name || '-ZZSMOKE';
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE FAIL: % packages did not follow batch rename', v_bad; END IF;

  -- 3) strain rename propagates to package strain text
  UPDATE strains SET name = v_new_sn || '-ZZSMOKE' WHERE id = v_new_s;
  SELECT count(*) INTO v_bad FROM packages WHERE batch_id = v_batch AND strain <> v_new_sn || '-ZZSMOKE';
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE FAIL: % packages did not follow strain rename', v_bad; END IF;

  -- 4) legacy text-only write moves a package to another batch
  SELECT p.tag_id, p.type_id, p.created_by INTO v_pkg, v_type, v_user FROM packages p WHERE p.batch_id = v_batch LIMIT 1;
  SELECT count(*) INTO v_n FROM batches WHERE id <> v_batch AND strain_id IS NOT NULL;
  IF v_n > 0 THEN
    UPDATE packages SET batch = (SELECT name FROM batches WHERE id <> v_batch AND strain_id IS NOT NULL LIMIT 1)
     WHERE tag_id = v_pkg;
    SELECT count(*) INTO v_bad FROM packages p JOIN batches b ON b.name = p.batch
     WHERE p.tag_id = v_pkg AND p.batch_id = b.id AND b.id <> v_batch;
    IF v_bad <> 1 THEN RAISE EXCEPTION 'SMOKE FAIL: text-only batch write did not resolve batch_id'; END IF;
  END IF;

  -- 5) bogus batch_id is rejected
  BEGIN
    INSERT INTO packages (tag_id, batch, strain, type_id, created_by, batch_id)
    VALUES ('ZZSMOKE-BOGUS', 'x', 'x', v_type, v_user, gen_random_uuid());
    RAISE EXCEPTION 'SMOKE FAIL: insert with bogus batch_id succeeded';
  EXCEPTION WHEN raise_exception OR foreign_key_violation THEN
    IF SQLERRM LIKE 'SMOKE FAIL%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'packages_batch_sync_smoke OK' AS result;

ROLLBACK;
