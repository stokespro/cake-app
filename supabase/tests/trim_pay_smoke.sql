-- Harvest & Trim Phase 3 SQL smoke test: batch close, pay approval -> finance bill, reversal, reopen.
-- Plan: .context/harvest-trim-plan.md (2.7, R2.10, R2.14, R2.15). Companion to harvest_trim_smoke.sql.
--
-- Exercises 20261020090000_trim_batch_close_and_pay_workflow.sql: close blocked by an unfinished / flagged
-- / partial load (blockers named), close needing a reconciled load, the rack-count speed bump, close flipping
-- entries open -> ready WITHOUT touching is_active, the reconciliation tripwire (total mismatch, offsetting
-- mismatch, dropped entry, and the voided-partial population caveat), approval creating exactly one bill with the
-- right vendor / amount / due_date / derived period_month and writing no payment column, TRIM_E_NO_VENDOR, the
-- due-date bounds, the R2.15 rate-change note, double-approve blocked by the function AND the unique index,
-- reversal voiding the bill and returning entries to ready, reversal refused once a payment exists, reopen
-- refused once a payout is approved, the closed-batch load trigger, every ROW_COUNT guard (sabotage probes),
-- constraints, privileges and final cross-table invariants.
--
-- HOW TO RUN: one BEGIN ... ROLLBACK block that writes real rows and then throws them all away, so it is safe
-- against the live database - but run it only AFTER 20261013090000, 20261013091000, 20261014090000 AND
-- 20261020090000 are applied.
--   psql:        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/trim_pay_smoke.sql
--   execute_sql: paste the whole file as one call.
-- On success the last result set is one row: assertions_passed = N. Any failure aborts with
-- 'SMOKE FAIL: <label>' and the trailing ROLLBACK discards everything.
--
-- FIXTURES: borrows one admin user, one ordinary (non-admin, non-management) user, one ACTIVE room_cycle with a
-- harvest_date and one strain; creates its own vendors (finance_vendors rows), trimmers, hangers (ZZ4-), batches
-- (ZZPAY-*), bills and payments. Nothing survives the ROLLBACK. It never writes users / room_cycles / grow_rooms.

BEGIN;

CREATE TEMP TABLE smoke_log (n serial PRIMARY KEY, label text NOT NULL) ON COMMIT DROP;

-- ---- assertion helpers (same shapes as harvest_trim_smoke.sql) --------------------------------------

CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE FAIL: %', p_label; END IF;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

-- p_sql must raise SQLSTATE p_sqlstate (2 chars = whole class) with p_needle in the message.
CREATE FUNCTION pg_temp.expect_err(p_sql text, p_sqlstate text, p_needle text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text; v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true; v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'SMOKE FAIL (no error raised): %', p_label; END IF;
  IF NOT (v_state = p_sqlstate OR (length(p_sqlstate) = 2 AND left(v_state, 2) = p_sqlstate)) OR position(p_needle IN v_msg) = 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL (wrong error): % -> got [%] %', p_label, v_state, v_msg;
  END IF;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

-- p_setup runs first and p_sql must then raise; BOTH are rolled back, so a tamper never leaks.
CREATE FUNCTION pg_temp.expect_err_after(p_setup text, p_sql text, p_sqlstate text, p_needle text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text; v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_setup;
    BEGIN
      EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
      v_raised := true; v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    RAISE EXCEPTION 'probe' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'SMOKE FAIL (no error raised): %', p_label; END IF;
  IF NOT (v_state = p_sqlstate OR (length(p_sqlstate) = 2 AND left(v_state, 2) = p_sqlstate)) OR position(p_needle IN v_msg) = 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL (wrong error): % -> got [%] %', p_label, v_state, v_msg;
  END IF;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

-- p_setup then p_sql must both succeed; effects rolled back (probe).
CREATE FUNCTION pg_temp.expect_ok_after(p_setup text, p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    BEGIN
      EXECUTE p_setup;
      EXECUTE p_sql;
      RAISE EXCEPTION 'probe' USING ERRCODE = 'P0099';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
    RAISE EXCEPTION 'SMOKE FAIL (expected success): % -> got [%] %', p_label, v_state, v_msg;
  END;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

CREATE FUNCTION pg_temp.expect_ok(p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.expect_ok_after('SELECT 1', p_sql, p_label); END $$;

-- ROW-COUNT-GUARD probe: inside a rolled-back sub-transaction a BEFORE UPDATE trigger on p_table silently
-- swallows every row update (RETURN NULL) - exactly what a row that is no longer in the expected state looks
-- like to the function's UPDATE ... GET DIAGNOSTICS check. The call must RAISE TRIM_E_STATE; if the row-count
-- assertion were removed the call would "succeed" having changed nothing.
CREATE FUNCTION pg_temp.expect_swallowed_update(p_table text, p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.expect_err_after(
    format($f$CREATE FUNCTION public.zz_sabotage() RETURNS trigger LANGUAGE plpgsql AS $y$ BEGIN RETURN NULL; END $y$;
              CREATE TRIGGER zz_sabotage BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.zz_sabotage()$f$, p_table),
    p_sql, 'P0001', 'TRIM_E_STATE', 'ROW-COUNT GUARD: ' || p_label);
END $$;

CREATE FUNCTION pg_temp.pay(p_flower_g numeric, p_rate numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT round(p_flower_g / 453.59237 * p_rate, 2) $$;

CREATE FUNCTION pg_temp.evn() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.trim_events $$;

CREATE FUNCTION pg_temp.nbills(p_vendor uuid) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.finance_bills WHERE vendor_id = p_vendor $$;

CREATE FUNCTION pg_temp.nent(p_batch uuid, p_trimmer uuid, p_status text) RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.trim_pay_entries WHERE batch_id = p_batch AND trimmer_id = p_trimmer AND status = p_status $$;

-- hung -> dried -> checked out -> complete in-threshold return -> reconciled. Returns the check-in result.
CREATE FUNCTION pg_temp.mk_return(p_hanger uuid, p_batch uuid, p_staff uuid, p_dry numeric,
                                  p_flower numeric, p_trim numeric, p_stems numeric, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_load public.hanger_loads; v_r jsonb; v_rate numeric;
BEGIN
  v_load := public.fn_trim_create_load(p_hanger, p_batch, 10, p_dry * 3, NULL, 'harvest', p_actor);
  v_r := public.fn_trim_checkout(v_load.id, p_staff, p_dry, p_actor);
  v_rate := (v_r->'checkout'->>'rate_per_lb_applied')::numeric;
  RETURN public.fn_trim_checkin((v_r->'checkout'->>'id')::uuid, 'complete', p_flower, p_trim, p_stems,
                                'ok', 5.00, 25.00, pg_temp.pay(p_flower, v_rate), p_actor, NULL, NULL);
END $$;

DO $smoke$
DECLARE
  v_admin uuid; v_ops uuid; v_cycle uuid; v_strain uuid; v_cycle_sum text;
  v_V uuid; v_VI uuid; v_staffA uuid; v_staffB uuid; v_staffC uuid; v_staffE uuid;
  v_P1 uuid; v_P2 uuid; v_P3 uuid; v_P4 uuid; v_P5 uuid; v_P6 uuid; v_P7 uuid;
  v_h uuid[]; v_r jsonb; v_row public.hanger_loads;
  v_L1 uuid; v_L2 uuid; v_L3 uuid; v_L4 uuid; v_L5 uuid;
  v_co jsonb; v_co3 uuid; v_co5 uuid;
  v_today date; v_close_date date; v_due date; v_due2 date;
  v_ev bigint; v_n bigint; v_txt text;
  v_pA uuid; v_bA uuid; v_pA2 uuid; v_bA2 uuid; v_pA3 uuid; v_bA3 uuid; v_pA4 uuid; v_pB uuid;
  v_bill public.finance_bills; v_pay public.trim_payouts;
  v_rawbill uuid; v_amtA numeric; v_amtB numeric; v_amtP2A numeric;
  v_e2A uuid; v_e2B uuid; v_staffD uuid;
BEGIN
  -- ============================ fixtures (borrowed, never modified) ============================
  SELECT id INTO v_admin FROM public.users WHERE role = 'admin' LIMIT 1;
  SELECT id INTO v_ops   FROM public.users WHERE role NOT IN ('admin','management') LIMIT 1;
  SELECT id, md5(room_cycles::text) INTO v_cycle, v_cycle_sum
    FROM public.room_cycles WHERE status = 'active' AND harvest_date IS NOT NULL LIMIT 1;
  SELECT id INTO v_strain FROM public.strains ORDER BY id LIMIT 1;
  IF v_admin IS NULL OR v_ops IS NULL OR v_cycle IS NULL OR v_strain IS NULL THEN
    RAISE EXCEPTION 'SMOKE SETUP: needs an admin user, an ordinary (non-admin, non-management) user, an active room_cycle with a harvest_date and a strain';
  END IF;
  v_today := (now() AT TIME ZONE 'America/Chicago')::date;

  -- ============================ privileges / RLS / schema surface ============================
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_close_batch(uuid,uuid,integer)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_trim_close_batch(uuid,uuid,integer)', 'EXECUTE'), 'anon / authenticated cannot execute fn_trim_close_batch');
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_approve_payout(uuid,uuid,date,uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_trim_approve_payout(uuid,uuid,date,uuid)', 'EXECUTE'), 'anon / authenticated cannot execute fn_trim_approve_payout');
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_reverse_payout(uuid,text,uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_trim_reverse_payout(uuid,text,uuid)', 'EXECUTE'), 'anon / authenticated cannot execute fn_trim_reverse_payout');
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_reopen_batch(uuid,text,uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_trim_reopen_batch(uuid,text,uuid)', 'EXECUTE'), 'anon / authenticated cannot execute fn_trim_reopen_batch');
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_fmt_rate(numeric,numeric)', 'EXECUTE')
                     AND NOT has_function_privilege('authenticated', 'public.fn_trim_loads_block_closed_batch()', 'EXECUTE'), 'internal helper and trigger function are not executable by anon / authenticated');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.fn_trim_close_batch(uuid,uuid,integer)', 'EXECUTE')
                     AND has_function_privilege('service_role', 'public.fn_trim_approve_payout(uuid,uuid,date,uuid)', 'EXECUTE')
                     AND has_function_privilege('service_role', 'public.fn_trim_reverse_payout(uuid,text,uuid)', 'EXECUTE')
                     AND has_function_privilege('service_role', 'public.fn_trim_reopen_batch(uuid,text,uuid)', 'EXECUTE'), 'service_role can execute all four Phase 3 functions');
  PERFORM pg_temp.ok(NOT has_table_privilege('anon', 'public.trim_payouts', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.trim_payouts', 'INSERT'), 'anon / authenticated have no trim_payouts access');
  PERFORM pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trim_payouts'::regclass), 'RLS enabled on trim_payouts');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('fn_trim_close_batch','fn_trim_approve_payout','fn_trim_reverse_payout','fn_trim_reopen_batch')
                                    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT 'search_path=public' = ANY (p.proconfig))), 'all four functions are SECURITY DEFINER with search_path pinned');
  PERFORM pg_temp.ok((SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'batches' AND column_name = 'trim_closed_at')
                     AND (SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trim_pay_entries' AND column_name = 'payout_id'), 'batches.trim_closed_at and trim_pay_entries.payout_id are nullable');
  PERFORM pg_temp.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.trim_pay_entries'::regclass AND conname = 'trim_pay_entries_status_check') LIKE '%open%ready%approved%'
                     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.trim_pay_entries'::regclass AND conname = 'trim_pay_entries_status_check') NOT LIKE '%paid%', 'trim_pay_entries status set is still open | ready | approved (Phase 1, unchanged)');

  -- ============================ fixtures we create ============================
  INSERT INTO public.finance_vendors (name, category) VALUES ('ZZ Smoke Trim Vendor', 'payroll') RETURNING id INTO v_V;
  INSERT INTO public.finance_vendors (name, category, is_active) VALUES ('ZZ Smoke Inactive Vendor', 'payroll', false) RETURNING id INTO v_VI;
  INSERT INTO public.trim_staff (full_name, pay_per_lb, vendor_id, created_by) VALUES ('Smoke Pay A', 200, v_V, v_ops) RETURNING id INTO v_staffA;
  INSERT INTO public.trim_staff (full_name, pay_per_lb, created_by)             VALUES ('Smoke Pay B', 250, v_ops) RETURNING id INTO v_staffB;       -- NO vendor
  INSERT INTO public.trim_staff (full_name, pay_per_lb, vendor_id, created_by) VALUES ('Smoke Pay C', 100, v_VI, v_ops) RETURNING id INTO v_staffC;   -- inactive vendor
  INSERT INTO public.trim_staff (full_name, pay_per_lb, vendor_id, created_by) VALUES ('Smoke Pay E', 100, v_V, v_ops) RETURNING id INTO v_staffE;    -- never trims
  PERFORM public.fn_create_hangers('ZZ4-', 1, 20, 3, v_ops);
  SELECT array_agg(id ORDER BY code) INTO v_h FROM public.hangers WHERE code LIKE 'ZZ4-%';
  PERFORM public.fn_trim_declare_batches(v_cycle, (
    SELECT jsonb_agg(jsonb_build_object('strain_id', v_strain, 'name', 'ZZPAY-' || i) ORDER BY i) FROM generate_series(1, 7) i), v_ops);
  SELECT id INTO v_P1 FROM public.batches WHERE name = 'ZZPAY-1';
  SELECT id INTO v_P2 FROM public.batches WHERE name = 'ZZPAY-2';
  SELECT id INTO v_P3 FROM public.batches WHERE name = 'ZZPAY-3';
  SELECT id INTO v_P4 FROM public.batches WHERE name = 'ZZPAY-4';
  SELECT id INTO v_P5 FROM public.batches WHERE name = 'ZZPAY-5';
  SELECT id INTO v_P6 FROM public.batches WHERE name = 'ZZPAY-6';
  SELECT id INTO v_P7 FROM public.batches WHERE name = 'ZZPAY-7';

  -- ============================================================================================
  -- 1. CLOSE BLOCKED  (batch ZZPAY-1: reconciled x2, partial, hung, flagged)
  -- ============================================================================================
  PERFORM pg_temp.mk_return(v_h[1], v_P1, v_staffA, 1000, 600, 300, 100, v_ops);                    -- L1: A, 600 g
  PERFORM pg_temp.mk_return(v_h[2], v_P1, v_staffB,  800, 450, 250, 100, v_ops);                    -- L2: B, 450 g
  v_row := public.fn_trim_create_load(v_h[3], v_P1, 10, 6000, NULL, 'harvest', v_ops); v_L3 := v_row.id;   -- L3: A, unfinished -> partial
  v_co := public.fn_trim_checkout(v_L3, v_staffA, 2000, v_ops);
  v_co3 := (v_co->'checkout'->>'id')::uuid;
  v_r := public.fn_trim_checkin(v_co3, 'unfinished', 400, 200, 100, 'ok', 5.00, 25.00, pg_temp.pay(400, 200), v_ops, 1300, 6);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial', 'fixture: L3 is partial after an unfinished return');
  v_row := public.fn_trim_create_load(v_h[4], v_P1, 5, 3000, NULL, 'harvest', v_ops); v_L4 := v_row.id;   -- L4: hung
  v_row := public.fn_trim_create_load(v_h[5], v_P1, 5, 1500, NULL, 'harvest', v_ops); v_L5 := v_row.id;   -- L5: flagged return
  v_co := public.fn_trim_checkout(v_L5, v_staffB, 500, v_ops);
  v_co5 := (v_co->'checkout'->>'id')::uuid;
  v_r := public.fn_trim_checkin(v_co5, 'complete', 100, 100, 50, 'flagged', 5.00, 25.00, NULL, v_ops, NULL, NULL);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'returned' AND v_r->'pay_entry' = 'null'::jsonb, 'fixture: L5 is a flagged return (status returned, no pay entry yet)');

  v_ev := pg_temp.evn();
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L)', v_P1, v_admin), 'P0001', 'TRIM_E_STATE', 'close: blocked while loads are unfinished');
  BEGIN
    PERFORM public.fn_trim_close_batch(v_P1, v_admin);
  EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM;
  END;
  PERFORM pg_temp.ok(position('ZZ4-003 (partial)' IN v_txt) > 0 AND position('ZZ4-004 (hung)' IN v_txt) > 0 AND position('ZZ4-005 (flagged)' IN v_txt) > 0
                     AND position('ZZ4-001' IN v_txt) = 0 AND position('ZZ4-002' IN v_txt) = 0 AND position('3 load(s)' IN v_txt) > 0,
                     'close: the error names exactly the blocking hangers and their states (partial / hung / flagged), not the finished ones');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev, 'close: a refused close writes no event');
  PERFORM pg_temp.ok((SELECT trim_closed_at IS NULL AND trim_closed_by IS NULL FROM public.batches WHERE id = v_P1)
                     AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE batch_id = v_P1 AND status <> 'open'), 'close: a refused close changes nothing (batch still open, entries still open)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,NULL)', v_P1), 'P0001', 'TRIM_E_INVALID', 'close: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L)', '00000000-0000-0000-0000-000000000001', v_admin), 'P0001', 'TRIM_E_NOT_FOUND', 'close: unknown batch');
  -- a batch whose only load is void has nothing to close
  v_row := public.fn_trim_create_load(v_h[12], v_P7, 5, 1000, NULL, 'harvest', v_ops);
  PERFORM public.fn_trim_void(v_row.id, 'weighed on the wrong hanger', v_ops);
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L)', v_P7, v_admin), 'P0001', 'no reconciled load', 'close: a batch with only void loads (no reconciled load) is refused');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L)', v_P6, v_admin), 'P0001', 'no reconciled load', 'close: an empty batch is refused');

  -- unblock: void the hung load, accept the flagged one, admin-void the partial one (its pay entry must survive)
  PERFORM public.fn_trim_void(v_L4, 'duplicate weigh-in', v_ops);
  PERFORM public.fn_trim_resolve_variance(v_co5, 'accepted - scale drift on the bin', pg_temp.pay(100, 250), v_ops);
  PERFORM public.fn_trim_void(v_L3, 'abandoned remainder - admin override', v_admin);
  PERFORM pg_temp.ok((SELECT status FROM public.hanger_loads WHERE id = v_L3) = 'void'
                     AND (SELECT count(*) FROM public.trim_pay_entries WHERE batch_id = v_P1 AND trimmer_id = v_staffA) = 2,
                     'fixture: voiding the partial load left its earlier pay entry in place (A has 2 entries)');

  -- ============================================================================================
  -- 2. CLOSE: rack count, success, is_active untouched, entries -> ready
  -- ============================================================================================
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L,4)', v_P1, v_admin), 'P0001', 'rack count mismatch', 'close: confirmedHangerCount that disagrees with the reconciled hangers is refused');
  PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_close_batch(%L,%L,3)', v_P1, v_ops), 'close: the plan signature (batch, actor) and the optional rack count both work (probe)');
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_close_batch(v_P1, v_ops);
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1 AND (SELECT event_type = 'batch_closed' AND actor_user_id = v_ops AND batch_id = v_P1
                       FROM public.trim_events ORDER BY id DESC LIMIT 1), 'close: exactly one batch_closed event, actor = p_actor');
  PERFORM pg_temp.ok((v_r->>'ready_entries')::int = 4 AND (v_r->>'reconciled_loads')::int = 3 AND (v_r->>'void_loads')::int = 2 AND (v_r->>'hangers')::int = 3
                     AND (v_r->>'total_flower_g')::numeric = 1550 AND (v_r->>'batch_name') = 'ZZPAY-1'
                     AND jsonb_array_length(v_r->'trimmers') = 2, 'close: result reports 4 ready entries, 3 reconciled + 2 void loads, 3 hangers, 1550 g, 2 trimmers');
  PERFORM pg_temp.ok((v_r->>'total_amount')::numeric = pg_temp.pay(600,200) + pg_temp.pay(450,250) + pg_temp.pay(400,200) + pg_temp.pay(100,250), 'close: total_amount equals the sum of the four entries');
  PERFORM pg_temp.ok((SELECT trim_closed_at IS NOT NULL AND trim_closed_by = v_ops FROM public.batches WHERE id = v_P1), 'close: trim_closed_at / trim_closed_by stamped');
  PERFORM pg_temp.ok((SELECT is_active = false FROM public.batches WHERE id = v_P1), 'close: is_active is NOT touched (trim-complete is not sellable, R2.10)');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_pay_entries WHERE batch_id = v_P1 AND status = 'ready' AND payout_id IS NULL) = 4
                     AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE batch_id = v_P1 AND status <> 'ready'), 'close: all four entries flipped open -> ready (none approved, none left open)');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.finance_bills WHERE name LIKE 'Trim - ZZPAY-%') = 0, 'close: raises no bill (approval does)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_close_batch(%L,%L)', v_P1, v_admin), 'P0001', 'already trim-closed', 'close: closing twice is refused');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen(%L,%L,%L)', (SELECT id FROM public.hanger_loads WHERE hanger_id = v_h[1]), 'wrong flower weight', v_admin), 'P0001', 'TRIM_E_STATE', 'Phase 1 fn_trim_reopen refuses a reconciled load whose entry is already ready');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,1000,NULL,%L,%L)', v_h[6], v_P1, 'harvest', v_ops), 'P0001', 'trim-closed', 'closed batch: a new load is refused (trigger)');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.hanger_loads (hanger_id, batch_id, status, wet_g, wet_recorded_at) VALUES (%L, %L, 'hung', 100, now())$f$, v_h[6], v_P1), 'P0001', 'trim-closed', 'closed batch: a raw load insert is refused too');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.hanger_loads WHERE hanger_id = v_h[6]), 'closed batch: the refused loads left nothing behind');

  -- ============================================================================================
  -- 3. RECONCILIATION TRIPWIRE  (batch ZZPAY-2: A 300 g, B 200 g; all tampering is rolled back)
  -- ============================================================================================
  PERFORM pg_temp.mk_return(v_h[6], v_P2, v_staffA, 500, 300, 150, 50, v_ops);
  PERFORM pg_temp.mk_return(v_h[7], v_P2, v_staffB, 400, 200, 150, 50, v_ops);
  SELECT id INTO v_e2A FROM public.trim_pay_entries WHERE batch_id = v_P2 AND trimmer_id = v_staffA;
  SELECT id INTO v_e2B FROM public.trim_pay_entries WHERE batch_id = v_P2 AND trimmer_id = v_staffB;
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET flower_g = 310, amount = %L WHERE id = %L', pg_temp.pay(310, 200), v_e2A),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'TRIM_E_RECONCILE',
    'TRIPWIRE: pay entries total more flower than the returned episodes -> close refused');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET flower_g = 190, amount = %L WHERE id = %L', pg_temp.pay(190, 250), v_e2B),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'pay has drifted',
    'TRIPWIRE: pay entries total LESS than the returned episodes -> close refused');
  PERFORM pg_temp.expect_err_after(format('DELETE FROM public.trim_pay_entries WHERE id = %L', v_e2B),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'TRIM_E_RECONCILE',
    'TRIPWIRE: a returned episode with no pay entry -> close refused');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET flower_g = 310, amount = %L WHERE id = %L; UPDATE public.trim_pay_entries SET flower_g = 190, amount = %L WHERE id = %L',
                                          pg_temp.pay(310, 200), v_e2A, pg_temp.pay(190, 250), v_e2B),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'one-to-one',
    'TRIPWIRE: offsetting errors (+10 g / -10 g, totals EQUAL) are still caught by the one-to-one match');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET status = %L WHERE id = %L', 'approved', v_e2A),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'already ready / approved',
    'close: an entry that is already ready / approved on an unclosed batch is refused');
  PERFORM pg_temp.ok((SELECT trim_closed_at IS NULL FROM public.batches WHERE id = v_P2) AND pg_temp.nent(v_P2, v_staffA, 'open') = 1 AND pg_temp.nent(v_P2, v_staffB, 'open') = 1, 'TRIPWIRE: nothing was persisted by the refused closes');
  -- population: ZZPAY-1 closed above WITH a voided partial load whose entry still exists - both sides count it
  PERFORM pg_temp.ok((SELECT sum(flower_g) FROM public.trim_pay_entries WHERE batch_id = v_P1)
                     = (SELECT sum(c.flower_g) FROM public.trim_checkouts c JOIN public.hanger_loads l ON l.id = c.load_id WHERE l.batch_id = v_P1 AND c.status = 'returned'), 'TRIPWIRE population: voided-partial entries are counted on BOTH sides (ZZPAY-1 closed with one)');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_checkouts c JOIN public.hanger_loads l ON l.id = c.load_id WHERE l.batch_id = v_P1 AND c.status = 'returned' AND l.status = 'void') = 1, 'TRIPWIRE population: ZZPAY-1 really does contain a returned episode on a void load');
  PERFORM public.fn_trim_close_batch(v_P2, v_admin, 2);
  PERFORM pg_temp.ok((SELECT trim_closed_at IS NOT NULL FROM public.batches WHERE id = v_P2) AND pg_temp.nent(v_P2, v_staffA, 'ready') = 1 AND pg_temp.nent(v_P2, v_staffB, 'ready') = 1, 'TRIPWIRE: the untouched batch closes cleanly');

  -- ============================================================================================
  -- 4. APPROVE  (ZZPAY-1 / trimmer A)
  -- ============================================================================================
  v_due := (date_trunc('month', v_today) + interval '1 month' + interval '14 days')::date;  -- mid next month
  v_ev := pg_temp.evn(); v_n := pg_temp.nbills(v_V);
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,NULL,%L)', v_P1, v_staffA, v_ops), 'P0001', 'TRIM_E_INVALID', 'approve: due date required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,NULL)', v_P1, v_staffA, v_due), 'P0001', 'TRIM_E_INVALID', 'approve: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_due, '00000000-0000-0000-0000-000000000001'), 'P0001', 'TRIM_E_INVALID', 'approve: actor must be a real user');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', '00000000-0000-0000-0000-000000000001', v_staffA, v_due, v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'approve: unknown batch');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, '00000000-0000-0000-0000-000000000001', v_due, v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'approve: unknown trimmer');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P6, v_staffA, v_due, v_ops), 'P0001', 'not trim-closed', 'approve: the batch must be trim-closed');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffB, v_due, v_ops), 'P0001', 'TRIM_E_NO_VENDOR', 'approve: a trimmer with no vendor raises TRIM_E_NO_VENDOR');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffE, v_due, v_ops), 'P0001', 'no ready pay entries', 'approve: a trimmer with no entries on the batch is refused');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_today - 1, v_ops), 'P0001', 'before the batch was trim-closed', 'approve: due date before the trim-close date refused');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_today + 366, v_ops), 'P0001', 'more than a year out', 'approve: due date more than a year out refused');
  PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_today, v_ops), 'approve: a due date equal to the trim-close date is allowed (probe)');
  PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_today + 365, v_ops), 'approve: a due date exactly 365 days out is allowed (probe)');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET status = %L WHERE batch_id = %L AND trimmer_id = %L', 'open', v_P1, v_staffA),
    format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_due, v_ops), 'P0001', 'are not ready',
    'approve: refuses when any of the trimmer''s entries is not ready');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.finance_vendors SET is_active = false WHERE id = %L', v_V),
    format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_due, v_ops), 'P0001', 'is inactive',
    'approve: refuses an inactive vendor');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev AND pg_temp.nbills(v_V) = v_n AND NOT EXISTS (SELECT 1 FROM public.trim_payouts WHERE batch_id = v_P1), 'approve: every refused call wrote no event, no bill, no payout');

  v_ev := pg_temp.evn();
  v_r := public.fn_trim_approve_payout(v_P1, v_staffA, v_due, v_ops);
  v_bill := jsonb_populate_record(NULL::public.finance_bills, v_r->'bill');
  v_pay  := jsonb_populate_record(NULL::public.trim_payouts, v_r->'payout');
  v_pA := v_pay.id; v_bA := v_bill.id;
  v_amtA := pg_temp.pay(600, 200) + pg_temp.pay(400, 200);
  PERFORM pg_temp.ok(pg_temp.nbills(v_V) = v_n + 1, 'approve: creates exactly one bill for the trimmer''s vendor');
  PERFORM pg_temp.ok(v_bill.vendor_id = v_V AND v_bill.amount = v_amtA AND v_bill.due_date = v_due, 'approve: bill carries the right vendor, amount and due_date');
  PERFORM pg_temp.ok(v_bill.period_month = (left(v_due::text, 7) || '-01')::date AND v_bill.period_month = date_trunc('month', v_due)::date
                     AND v_bill.period_month <> date_trunc('month', v_today)::date, 'approve: period_month is derived from the due date (first of the month; matches derivePeriodMonth)');
  PERFORM pg_temp.ok(v_bill.name = 'Trim - ZZPAY-1 - Smoke Pay A' AND v_bill.created_by = v_ops, 'approve: bill name is "Trim - <batch> - <trimmer>", created_by = p_actor');
  PERFORM pg_temp.ok(v_bill.status = 'unpaid' AND v_bill.amount_paid = 0 AND v_bill.paid_date IS NULL AND v_bill.payment_method IS NULL AND v_bill.payment_ref IS NULL
                     AND v_bill.planned_pay_date IS NULL AND v_bill.template_id IS NULL, 'approve: bill is plain unpaid - no payment column and nothing else written (trigger-derived columns untouched)');
  PERFORM pg_temp.ok(v_bill.notes LIKE '%Hangers: 2 (2 episodes)%' AND v_bill.notes LIKE '%Flower: 2.20 lb (1,000.00 g)%' AND v_bill.notes LIKE '%Rate: $200.00/lb%'
                     AND v_bill.notes LIKE '%Approved by%' AND v_bill.notes NOT LIKE '%RATE CHANGED%', 'approve: notes carry the hanger / flower lb / rate breakdown and no rate-change line on a first payout');
  PERFORM pg_temp.ok(v_pay.batch_id = v_P1 AND v_pay.trimmer_id = v_staffA AND v_pay.vendor_id = v_V AND v_pay.flower_g = 1000 AND v_pay.amount = v_amtA
                     AND v_pay.due_date = v_due AND v_pay.bill_id = v_bA AND v_pay.status = 'approved' AND v_pay.approved_by = v_ops
                     AND v_pay.reversed_at IS NULL AND v_pay.reversed_by IS NULL AND v_pay.reverse_reason IS NULL, 'approve: payout snapshot (batch, trimmer, vendor, flower_g, amount, due_date, bill_id, approver) is right');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_pay_entries WHERE payout_id = v_pA AND status = 'approved' AND trimmer_id = v_staffA AND batch_id = v_P1) = 2
                     AND pg_temp.nent(v_P1, v_staffA, 'approved') = 2, 'approve: both of A''s entries linked to the payout and approved');
  PERFORM pg_temp.ok(pg_temp.nent(v_P1, v_staffB, 'ready') = 2 AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE batch_id = v_P1 AND trimmer_id = v_staffB AND payout_id IS NOT NULL), 'approve: another trimmer''s entries on the same batch are untouched');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1 AND (SELECT event_type = 'payout_approved' AND actor_user_id = v_ops AND batch_id = v_P1 AND payload->>'payout_id' = v_pA::text AND payload->>'bill_id' = v_bA::text
                       FROM public.trim_events ORDER BY id DESC LIMIT 1), 'approve: exactly one payout_approved event, actor = p_actor, payout and bill ids in the payload');
  PERFORM pg_temp.ok((v_r->>'entry_count')::int = 2 AND (v_r->>'hangers')::int = 2 AND (v_r->>'rate_changed')::boolean = false, 'approve: result reports entry_count, hangers, rate_changed');

  -- double approve: function first, unique index as the backstop
  v_ev := pg_temp.evn(); v_n := pg_temp.nbills(v_V);
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P1, v_staffA, v_due, v_ops), 'P0001', 'TRIM_E_ALREADY_APPROVED', 'approve twice: refused with TRIM_E_ALREADY_APPROVED');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev AND pg_temp.nbills(v_V) = v_n, 'approve twice: no second bill, no event');
  INSERT INTO public.finance_bills (vendor_id, name, period_month, amount, due_date, status, amount_paid) VALUES (v_V, 'ZZ raw bill', date_trunc('month', v_due)::date, 10, v_due, 'unpaid', 0) RETURNING id INTO v_rawbill;
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by) VALUES (%L,%L,%L,1,10,%L,%L,%L)$f$, v_P1, v_staffA, v_V, v_due, v_rawbill, v_ops),
    '23505', 'uidx_trim_payouts_one_approved_per_pair', 'INDEX: a second approved payout for the same (batch, trimmer) is rejected by the unique index even with a different bill');
  PERFORM pg_temp.expect_ok(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by) VALUES (%L,%L,%L,1,10,%L,%L,%L)$f$, v_P2, v_staffA, v_V, v_due, v_rawbill, v_ops),
    'INDEX: the same trimmer on a different batch is a different pair (probe)');

  -- B: no vendor -> link one -> approve works (the retry flow)
  UPDATE public.trim_staff SET vendor_id = v_V WHERE id = v_staffB;
  v_r := public.fn_trim_approve_payout(v_P1, v_staffB, v_due, v_admin);
  v_pB := (v_r->'payout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'bill'->>'amount')::numeric = pg_temp.pay(450, 250) + pg_temp.pay(100, 250) AND (v_r->'bill'->>'name') = 'Trim - ZZPAY-1 - Smoke Pay B'
                     AND (v_r->'payout'->>'approved_by')::uuid = v_admin AND pg_temp.nent(v_P1, v_staffB, 'approved') = 2, 'approve: after linking a vendor the previously refused trimmer approves (second bill, admin actor)');

  -- ============================================================================================
  -- 5. R2.15 rate-change note  (ZZPAY-3: A at $225 ; ZZPAY-4: A still $225)
  -- ============================================================================================
  UPDATE public.trim_staff SET pay_per_lb = 225 WHERE id = v_staffA;
  PERFORM pg_temp.mk_return(v_h[8], v_P3, v_staffA, 700, 500, 150, 50, v_ops);
  PERFORM public.fn_trim_close_batch(v_P3, v_ops);
  v_r := public.fn_trim_approve_payout(v_P3, v_staffA, v_due, v_ops);
  v_pA3 := (v_r->'payout'->>'id')::uuid; v_bA3 := (v_r->'bill'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->>'rate_changed')::boolean AND (v_r->'bill'->>'notes') LIKE '%RATE CHANGED $200.00 -> $225.00/lb since last batch (ZZPAY-1)%', 'R2.15: a rate change since the previous approved payout is flagged in the bill notes, naming the old batch');
  PERFORM pg_temp.ok((SELECT (payload->>'rate_changed')::boolean AND (payload->>'previous_rate_min')::numeric = 200 AND (payload->>'rate_min')::numeric = 225 FROM public.trim_events ORDER BY id DESC LIMIT 1), 'R2.15: the event payload records the change');
  PERFORM pg_temp.mk_return(v_h[9], v_P4, v_staffA, 700, 500, 150, 50, v_ops);
  PERFORM public.fn_trim_close_batch(v_P4, v_ops);
  v_r := public.fn_trim_approve_payout(v_P4, v_staffA, v_due, v_ops);
  v_pA4 := (v_r->'payout'->>'id')::uuid;
  PERFORM pg_temp.ok(NOT (v_r->>'rate_changed')::boolean AND (v_r->'bill'->>'notes') NOT LIKE '%RATE CHANGED%', 'R2.15: the same rate as the previous approved payout adds no flag');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_payouts WHERE trimmer_id = v_staffA AND status = 'approved') = 3, 'R2.15 fixture: A holds three approved payouts');

  -- inactive vendor on a closed batch (C)
  PERFORM pg_temp.mk_return(v_h[10], v_P5, v_staffC, 300, 200, 50, 50, v_ops);
  PERFORM public.fn_trim_close_batch(v_P5, v_ops);
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P5, v_staffC, v_due, v_ops), 'P0001', 'is inactive', 'approve: a trimmer whose vendor is inactive is refused');

  -- ============================================================================================
  -- 6. REOPEN  (ZZPAY-2 has no payout; ZZPAY-1 does)
  -- ============================================================================================
  v_ev := pg_temp.evn();
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P1, 'oops wrong weight', v_admin), 'P0001', 'approved payout', 'reopen: refused while any payout is approved');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev AND (SELECT trim_closed_at IS NOT NULL FROM public.batches WHERE id = v_P1) AND pg_temp.nent(v_P1, v_staffA, 'approved') = 2, 'reopen refused: nothing changed');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P2, 'x', v_admin), 'P0001', 'TRIM_E_INVALID', 'reopen: reason required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,NULL)', v_P2, 'forgot a hanger'), 'P0001', 'TRIM_E_INVALID', 'reopen: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', '00000000-0000-0000-0000-000000000001', 'forgot a hanger', v_admin), 'P0001', 'TRIM_E_NOT_FOUND', 'reopen: unknown batch');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P6, 'forgot a hanger', v_admin), 'P0001', 'not trim-closed', 'reopen: a batch that is not closed is refused');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.trim_pay_entries SET status = %L WHERE id = %L', 'open', v_e2A),
    format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P2, 'forgot a hanger', v_admin), 'P0001', 'not ready', 'reopen: refuses when an entry is not in the ready state');
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_reopen_batch(v_P2, 'forgot a hanger on the rack', v_admin);
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1 AND (SELECT event_type = 'batch_reopened' AND actor_user_id = v_admin AND payload->>'reason' = 'forgot a hanger on the rack' FROM public.trim_events ORDER BY id DESC LIMIT 1), 'reopen: exactly one batch_reopened event, actor = p_actor, reason recorded');
  PERFORM pg_temp.ok((SELECT trim_closed_at IS NULL AND trim_closed_by IS NULL AND is_active = false FROM public.batches WHERE id = v_P2) AND (v_r->>'entries_reopened')::int = 2
                     AND pg_temp.nent(v_P2, v_staffA, 'open') = 1 AND pg_temp.nent(v_P2, v_staffB, 'open') = 1, 'reopen: close stamp cleared, entries ready -> open, is_active untouched');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P2, 'again please', v_admin), 'P0001', 'not trim-closed', 'reopen: twice is refused');
  -- the full correction loop: batch reopened -> Phase 1 can now reopen a reconciled load -> the batch cannot be re-closed until it is resolved
  PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_reopen(%L,%L,%L)', (SELECT id FROM public.hanger_loads WHERE hanger_id = v_h[6]), 'wrong flower weight on the scale', v_admin),
    'correction loop: after reopening the batch, Phase 1 fn_trim_reopen on a reconciled load works (probe)');
  PERFORM pg_temp.expect_err_after(format('SELECT public.fn_trim_reopen(%L,%L,%L)', (SELECT id FROM public.hanger_loads WHERE hanger_id = v_h[6]), 'wrong flower weight on the scale', v_admin),
    format('SELECT public.fn_trim_close_batch(%L,%L)', v_P2, v_admin), 'P0001', 'ZZ4-006 (flagged)', 'correction loop: the batch cannot be re-closed while the reopened load is unresolved');
  PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_create_load(%L,%L,5,1000,NULL,%L,%L)', v_h[13], v_P2, 'harvest', v_ops), 'reopen: lifts the closed-batch lock - a new load is accepted again (probe)');
  PERFORM public.fn_trim_close_batch(v_P2, v_admin);
  PERFORM pg_temp.ok(pg_temp.nent(v_P2, v_staffA, 'ready') = 1 AND pg_temp.nent(v_P2, v_staffB, 'ready') = 1, 'reopen then re-close works: entries ready again');
  v_amtP2A := pg_temp.pay(300, 200);

  -- ============================================================================================
  -- 7. REVERSE  (ZZPAY-1 / A)
  -- ============================================================================================
  v_ev := pg_temp.evn();
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA, 'x', v_admin), 'P0001', 'TRIM_E_INVALID', 'reverse: reason required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reverse_payout(%L,%L,NULL)', v_pA, 'entered the wrong rate'), 'P0001', 'TRIM_E_INVALID', 'reverse: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', '00000000-0000-0000-0000-000000000001', 'entered the wrong rate', v_admin), 'P0001', 'TRIM_E_NOT_FOUND', 'reverse: unknown payout');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev, 'reverse: refused calls write no event');
  v_r := public.fn_trim_reverse_payout(v_pA, 'entered the wrong rate', v_admin);
  PERFORM pg_temp.ok((SELECT status = 'void' AND amount = v_amtA AND due_date = v_due AND amount_paid = 0 AND notes LIKE '%VOIDED by trim payout reversal: entered the wrong rate%' FROM public.finance_bills WHERE id = v_bA), 'reverse: the bill is VOIDED (not deleted), amount / due date intact, reason appended to notes');
  PERFORM pg_temp.ok((SELECT status = 'reversed' AND reversed_by = v_admin AND reversed_at IS NOT NULL AND reverse_reason = 'entered the wrong rate' AND bill_id = v_bA FROM public.trim_payouts WHERE id = v_pA), 'reverse: payout marked reversed with who / when / why, bill_id kept');
  PERFORM pg_temp.ok(pg_temp.nent(v_P1, v_staffA, 'ready') = 2 AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE batch_id = v_P1 AND trimmer_id = v_staffA AND (payout_id IS NOT NULL OR status <> 'ready')), 'reverse: entries return to ready with payout_id cleared');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1 AND (SELECT event_type = 'payout_reversed' AND actor_user_id = v_admin AND payload->>'reason' = 'entered the wrong rate' FROM public.trim_events ORDER BY id DESC LIMIT 1), 'reverse: exactly one payout_reversed event, actor = p_actor');
  PERFORM pg_temp.ok((v_r->>'entries_returned')::int = 2, 'reverse: result reports entries_returned');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA, 'reverse it again', v_admin), 'P0001', 'only an approved payout can be reversed', 'reverse: an already reversed payout is refused');
  PERFORM pg_temp.ok(pg_temp.nbills(v_V) >= 1 AND EXISTS (SELECT 1 FROM public.finance_bills WHERE id = v_bA), 'reverse: the voided bill row still exists');
  -- re-approval after reversal is a fresh payout with a fresh bill
  v_due2 := v_due + 7;
  v_r := public.fn_trim_approve_payout(v_P1, v_staffA, v_due2, v_ops);
  v_pA2 := (v_r->'payout'->>'id')::uuid; v_bA2 := (v_r->'bill'->>'id')::uuid;
  PERFORM pg_temp.ok(v_pA2 <> v_pA AND v_bA2 <> v_bA AND (SELECT count(*) FROM public.trim_payouts WHERE batch_id = v_P1 AND trimmer_id = v_staffA) = 2
                     AND (SELECT count(*) FROM public.trim_payouts WHERE batch_id = v_P1 AND trimmer_id = v_staffA AND status = 'approved') = 1
                     AND (v_r->'bill'->>'due_date')::date = v_due2, 're-approve after reversal: new payout + new bill (the reversed one does not block the unique index)');
  -- a payment on the bill makes it unreversible
  INSERT INTO public.finance_bill_payments (bill_id, amount, paid_date, payment_method, payment_ref, created_by) VALUES (v_bA2, 10, v_today, 'check', '1001', v_ops);
  PERFORM pg_temp.ok((SELECT status = 'partial' AND amount_paid = 10 FROM public.finance_bills WHERE id = v_bA2), 'reverse fixture: the SPRO-82 trigger derived amount_paid / status from the payment (finance owns those columns)');
  v_ev := pg_temp.evn();
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA2, 'try to undo a paid bill', v_admin), 'P0001', 'TRIM_E_HAS_PAYMENTS', 'reverse: refused once the bill has ANY payment');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev AND (SELECT status = 'partial' FROM public.finance_bills WHERE id = v_bA2) AND (SELECT status = 'approved' FROM public.trim_payouts WHERE id = v_pA2)
                     AND pg_temp.nent(v_P1, v_staffA, 'approved') = 2, 'reverse refused: bill, payout and entries unchanged, no event');
  PERFORM pg_temp.expect_err(format('INSERT INTO public.finance_bill_payments (bill_id, amount, paid_date, payment_method) VALUES (%L, 1, %L, %L)', v_bA, v_today, 'cash'), '23514', 'BILL_VOID', 'finance side: a payment against the voided (reversed) bill is refused by finance''s own guard');
  -- a finance-voided bill with no payments must not strand the payout
  PERFORM pg_temp.expect_ok_after(format('UPDATE public.finance_bills SET status = %L WHERE id = %L', 'void', v_bA3),
    format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA3, 'finance already voided it', v_admin), 'reverse: a bill finance already voided (no payments) does not strand the payout (probe)');
  PERFORM pg_temp.expect_err_after(format('UPDATE public.finance_bills SET status = %L WHERE id = %L', 'paid', v_bA3),
    format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA3, 'drift', v_admin), 'P0001', 'refusing to reverse', 'reverse: a bill marked paid/partial with NO payment rows is drift - refused');

  -- ============================================================================================
  -- 8. ROW-COUNT GUARDS ARE LIVE (sabotage probes, all rolled back)
  -- ============================================================================================
  -- Each function UPDATE carries the expected prior status in its WHERE and asserts ROW_COUNT. A BEFORE UPDATE
  -- trigger that swallows the row stands in for "the row was no longer in the expected state": the call must
  -- RAISE TRIM_E_STATE rather than report success having changed nothing.
  PERFORM pg_temp.mk_return(v_h[11], v_P6, v_staffA, 600, 400, 100, 100, v_ops);       -- ZZPAY-6: closable, never actually closed
  -- a trimmer on $0/lb produces a $0 payout: nothing to bill, so approval refuses rather than raise a $0 bill
  INSERT INTO public.trim_staff (full_name, pay_per_lb, vendor_id, created_by) VALUES ('Smoke Pay D', 0, v_V, v_ops) RETURNING id INTO v_staffD;
  PERFORM pg_temp.mk_return(v_h[14], v_P6, v_staffD, 300, 200, 50, 50, v_ops);
  PERFORM pg_temp.expect_err_after(format('SELECT public.fn_trim_close_batch(%L,%L)', v_P6, v_admin),
    format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P6, v_staffD, v_due, v_ops), 'P0001', 'nothing is owed', 'approve: a $0 payout is refused (no $0 bill)');
  PERFORM pg_temp.expect_swallowed_update('batches', format('SELECT public.fn_trim_close_batch(%L,%L)', v_P6, v_admin), 'close: the batch stamp UPDATE is asserted (exactly one row)');
  PERFORM pg_temp.expect_swallowed_update('trim_pay_entries', format('SELECT public.fn_trim_close_batch(%L,%L)', v_P6, v_admin), 'close: the entry open -> ready flip is asserted (row count = entries)');
  PERFORM pg_temp.expect_swallowed_update('trim_pay_entries', format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P2, v_staffA, v_due, v_ops), 'approve: the entry ready -> approved flip is asserted');
  PERFORM pg_temp.expect_swallowed_update('finance_bills', format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA4, 'sabotage reverse', v_admin), 'reverse: the bill void UPDATE is asserted');
  PERFORM pg_temp.expect_swallowed_update('trim_payouts', format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA4, 'sabotage reverse', v_admin), 'reverse: the payout approved -> reversed UPDATE is asserted');
  -- the payout UPDATE's `AND status = 'approved'` predicate: reverse updates the bill BETWEEN locking the payout
  -- and updating it, so a trigger on finance_bills can flip the payout underneath it (a concurrent writer).
  PERFORM pg_temp.expect_err_after(
    format($f$CREATE FUNCTION public.zz_sabotage() RETURNS trigger LANGUAGE plpgsql AS $y$ BEGIN
                UPDATE public.trim_payouts SET status = 'reversed', reversed_at = now(), reverse_reason = 'concurrent reversal' WHERE id = %L; RETURN NEW; END $y$;
              CREATE TRIGGER zz_sabotage BEFORE UPDATE ON public.finance_bills FOR EACH ROW EXECUTE FUNCTION public.zz_sabotage()$f$, v_pA4),
    format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA4, 'sabotage reverse', v_admin),
    'P0001', 'TRIM_E_STATE', 'ROW-COUNT GUARD: reverse''s payout UPDATE is guarded by "AND status = approved" (payout changed mid-call raises)');
  PERFORM pg_temp.expect_swallowed_update('trim_pay_entries', format('SELECT public.fn_trim_reverse_payout(%L,%L,%L)', v_pA4, 'sabotage reverse', v_admin), 'reverse: the entry approved -> ready flip is asserted');
  PERFORM pg_temp.expect_swallowed_update('batches', format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P2, 'sabotage reopen', v_admin), 'reopen: the batch un-stamp UPDATE is asserted');
  PERFORM pg_temp.expect_swallowed_update('trim_pay_entries', format('SELECT public.fn_trim_reopen_batch(%L,%L,%L)', v_P2, 'sabotage reopen', v_admin), 'reopen: the entry ready -> open flip is asserted');
  -- the approve entry-UPDATE predicate `AND status = 'ready'`: fn_trim_fmt_rate is called by approve AFTER the
  -- entries were counted and BEFORE they are updated, so a sabotaged version can change the rows in between,
  -- like a concurrent writer that slipped past the lock. With the predicate the call raises; without it the
  -- stale UPDATE would flip the (now open) entries to approved and report success.
  PERFORM pg_temp.expect_err_after(
    format($f$CREATE OR REPLACE FUNCTION public.fn_trim_fmt_rate(p_min numeric, p_max numeric) RETURNS text LANGUAGE plpgsql AS $y$
                BEGIN UPDATE public.trim_pay_entries SET status = 'open' WHERE batch_id = %L; RETURN 'x'; END $y$$f$, v_P2),
    format('SELECT public.fn_trim_approve_payout(%L,%L,%L,%L)', v_P2, v_staffA, v_due, v_ops),
    'P0001', 'TRIM_E_STATE', 'ROW-COUNT GUARD: approve''s entry UPDATE is guarded by "AND status = ready" (entries changed mid-call raise)');
  PERFORM pg_temp.ok(pg_get_functiondef('public.fn_trim_fmt_rate(numeric,numeric)'::regprocedure) NOT LIKE '%trim_pay_entries%'
                     AND pg_temp.nent(v_P2, v_staffA, 'ready') = 1 AND NOT EXISTS (SELECT 1 FROM public.trim_payouts WHERE batch_id = v_P2 AND status = 'approved'),
                     'probes rolled back cleanly: real helper restored, ZZPAY-2 untouched');

  -- ============================================================================================
  -- 9. CONSTRAINTS, REFERENTIAL SAFETY, HELPERS
  -- ============================================================================================
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by, status) VALUES (%L,%L,%L,1,10,%L,%L,%L,'paid')$f$, v_P7, v_staffE, v_V, v_due, v_rawbill, v_ops), '23514', 'trim_payouts_status_check', 'CHECK trim_payouts status enum');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by) VALUES (%L,%L,%L,1,0,%L,%L,%L)$f$, v_P7, v_staffE, v_V, v_due, v_rawbill, v_ops), '23514', 'trim_payouts_amount_check', 'CHECK trim_payouts amount > 0');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by) VALUES (%L,%L,%L,-1,10,%L,%L,%L)$f$, v_P7, v_staffE, v_V, v_due, v_rawbill, v_ops), '23514', 'trim_payouts_flower_g_check', 'CHECK trim_payouts flower_g >= 0');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by, status) VALUES (%L,%L,%L,1,10,%L,%L,%L,'reversed')$f$, v_P7, v_staffE, v_V, v_due, v_rawbill, v_ops), '23514', 'payout_reversed_complete', 'CHECK payout_reversed_complete: a reversed payout needs when + why');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by, reversed_at) VALUES (%L,%L,%L,1,10,%L,%L,%L,now())$f$, v_P7, v_staffE, v_V, v_due, v_rawbill, v_ops), '23514', 'payout_approved_clean', 'CHECK payout_approved_clean: an approved payout carries no reversal data');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id) VALUES (%L,%L,%L,1,10,%L,%L)$f$, v_P7, v_staffE, v_V, v_due, v_rawbill), '23502', 'approved_by', 'trim_payouts.approved_by is NOT NULL');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, approved_by) VALUES (%L,%L,%L,1,10,%L,%L)$f$, v_P7, v_staffE, v_V, v_due, v_ops), '23502', 'bill_id', 'trim_payouts.bill_id is NOT NULL (a payout cannot exist without its bill)');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_payouts (batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id, approved_by) VALUES (%L,%L,%L,1,10,%L,%L,%L)$f$, v_P7, v_staffE, v_V, v_due, v_bA2, v_ops), '23505', 'trim_payouts_bill_id_key', 'UNIQUE: one bill belongs to at most one payout');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.trim_pay_entries SET payout_id = %L WHERE batch_id = %L AND status = 'ready'$f$, v_pA2, v_P2), '23514', 'pay_payout_only_when_approved', 'CHECK pay_payout_only_when_approved: a payout link requires status approved');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.finance_bills WHERE id = %L', v_bA), '23001', 'RESTRICT setting', 'FK RESTRICT: even the voided bill of a REVERSED payout cannot be deleted (the number stays auditable)');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.finance_bills WHERE id = %L', v_bA2), '23001', 'RESTRICT setting', 'FK RESTRICT: a bill that backs an approved payout cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.trim_payouts WHERE id = %L', v_pA4), '23001', 'RESTRICT setting', 'FK RESTRICT: a payout with linked entries cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.trim_staff WHERE id = %L', v_staffA), '23001', 'RESTRICT setting', 'FK RESTRICT: a trimmer with payouts cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.finance_vendors WHERE id = %L', v_V), '23001', 'RESTRICT setting', 'FK RESTRICT: a vendor with payouts cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.batches WHERE id = %L', v_P1), '23001', 'RESTRICT setting', 'FK RESTRICT: a batch with payouts cannot be deleted');
  PERFORM pg_temp.ok(public.fn_trim_fmt_rate(225, 225) = '$225.00' AND public.fn_trim_fmt_rate(200, 250.5) = '$200.00-$250.50' AND public.fn_trim_fmt_rate(NULL, 1) = 'n/a', 'fn_trim_fmt_rate: single rate, mixed range, null');
  PERFORM pg_temp.expect_err(format('UPDATE public.trim_events SET payload = %L WHERE event_type = %L', '{}', 'payout_approved'), 'P0001', 'append-only', 'the new event types are covered by the append-only trigger');

  -- ============================ final invariants over everything this script created ============================
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_pay_entries e LEFT JOIN public.trim_payouts p ON p.id = e.payout_id
                                  WHERE e.status = 'approved' AND (p.id IS NULL OR p.status <> 'approved' OR p.batch_id <> e.batch_id OR p.trimmer_id <> e.trimmer_id)),
                     'FINAL every approved entry is linked to an approved payout of the same batch and trimmer (the converse of the CHECK, which Phase 1''s smoke prevents us enforcing)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_payouts p JOIN public.finance_bills b ON b.id = p.bill_id
                                  WHERE p.status = 'approved'
                                    AND (b.status = 'void' OR b.amount <> p.amount OR b.vendor_id <> p.vendor_id OR b.due_date <> p.due_date
                                         OR b.period_month <> date_trunc('month', p.due_date)::date
                                         OR p.amount <> (SELECT sum(e.amount) FROM public.trim_pay_entries e WHERE e.payout_id = p.id)
                                         OR p.flower_g <> (SELECT sum(e.flower_g) FROM public.trim_pay_entries e WHERE e.payout_id = p.id))),
                     'FINAL every approved payout agrees with its bill (amount, vendor, due date, period) and with the sum of its entries (flower_g, amount)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_payouts p JOIN public.finance_bills b ON b.id = p.bill_id
                                  WHERE p.status = 'reversed' AND b.status <> 'void')
                     AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries e JOIN public.trim_payouts p ON p.id = e.payout_id WHERE p.status = 'reversed'),
                     'FINAL every reversed payout has a void bill and no linked entries');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.finance_bills WHERE name LIKE 'Trim - ZZPAY-%') = (SELECT count(*) FROM public.trim_payouts)
                     AND NOT EXISTS (SELECT 1 FROM public.finance_bills b WHERE b.name LIKE 'Trim - ZZPAY-%' AND NOT EXISTS (SELECT 1 FROM public.trim_payouts p WHERE p.bill_id = b.id)),
                     'FINAL every module-made bill belongs to exactly one payout, and every payout has its bill');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.finance_bills b WHERE b.name LIKE 'Trim - ZZPAY-%' AND b.status <> 'void'
                                  AND b.amount_paid <> coalesce((SELECT sum(amount) FROM public.finance_bill_payments x WHERE x.bill_id = b.id), 0)),
                     'FINAL module bills'' amount_paid still equals their payment ledger (this module never wrote it)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.batches b WHERE b.trim_closed_at IS NOT NULL
                                    AND (EXISTS (SELECT 1 FROM public.hanger_loads l WHERE l.batch_id = b.id AND l.status NOT IN ('reconciled','void'))
                                         OR EXISTS (SELECT 1 FROM public.trim_pay_entries e WHERE e.batch_id = b.id AND e.status = 'open'))),
                     'FINAL a closed batch has only reconciled / void loads and no open pay entries');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.batches b WHERE b.trim_closed_at IS NULL
                                    AND EXISTS (SELECT 1 FROM public.trim_pay_entries e WHERE e.batch_id = b.id AND e.status IN ('ready','approved'))),
                     'FINAL an unclosed batch has no ready / approved pay entries');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.batches WHERE name LIKE 'ZZPAY-%' AND is_active), 'FINAL no ZZPAY batch was ever made active (trim never touches is_active)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_events WHERE event_type IN ('batch_closed','payout_approved','payout_reversed','batch_reopened') AND (actor_user_id IS NULL OR batch_id IS NULL)),
                     'FINAL every Phase 3 event has an actor and a batch');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_events WHERE event_type = 'payout_approved') = (SELECT count(*) FROM public.trim_payouts), 'FINAL one payout_approved event per payout, ever');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_events WHERE event_type = 'payout_reversed') = (SELECT count(*) FROM public.trim_payouts WHERE status = 'reversed'), 'FINAL one payout_reversed event per reversed payout');
  PERFORM pg_temp.ok(coalesce((SELECT sum(flower_g) FROM public.trim_pay_entries), 0)
                   = coalesce((SELECT sum(flower_g) FROM public.trim_checkouts WHERE status = 'returned' AND variance_status IN ('ok','accepted')), 0),
                   'FINAL pay-entry flower equals the flower of ok/accepted returned episodes (Phase 1 invariant still holds)');
  PERFORM pg_temp.ok((SELECT md5(room_cycles::text) FROM public.room_cycles WHERE id = v_cycle) = v_cycle_sum, 'FINAL room_cycles untouched');
END
$smoke$;

SELECT count(*) AS assertions_passed FROM pg_temp.smoke_log;

ROLLBACK;
