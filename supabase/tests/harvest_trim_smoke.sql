-- Harvest & Trim SQL smoke test.
-- Plan: .context/harvest-trim-plan.md  (section 8 "SQL is the untestable part").
--
-- Exercises the Phase 1 migration (20261014090000_create_harvest_trim_core.sql): a 3-episode
-- partial chain, monotonic remaining, one complete return per load, gapless seq, the remaining
-- cache matching the newest returned episode, both custody/open unique-index violations, every
-- CHECK tripwire, the append-only events trigger, and the lpad() overflow raise.
--
-- HOW TO RUN: the whole file is one BEGIN ... ROLLBACK block. It writes real rows inside the
-- transaction and then throws every one of them away, so it is safe against the live database
-- (Vercel previews and the live app share one Supabase project, so there is no staging copy to
-- use instead) - but run it only AFTER migrations 20261013090000, 20261013091000 and 20261014090000 are applied.
--   psql:        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/harvest_trim_smoke.sql
--   execute_sql: paste the whole file as one call.
-- On success the last result set is one row: assertions_passed = N. Any failure aborts with
-- 'SMOKE FAIL: <label>' and the trailing ROLLBACK discards everything.
--
-- FIXTURES: it borrows existing rows rather than inventing them - one admin user, one ordinary
-- (neither admin nor management) user, optionally one management user (the management-void test is
-- skipped if none exists),-- user, one ACTIVE room_cycle with a harvest_date, and at least one strain. It creates its own
-- hangers (prefix ZZ1- / ZZ2-), trimmers, batches (ZZSMK-*) and everything downstream; none of it
-- survives the ROLLBACK. Nothing here ever touches room_cycles / grow_rooms / users (a checksum of
-- the borrowed cycle row is asserted unchanged).

BEGIN;

CREATE TEMP TABLE smoke_log (n serial PRIMARY KEY, label text NOT NULL) ON COMMIT DROP;

-- ---- assertion helpers (temp schema: they vanish with the session / transaction) ---------------

CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE FAIL: %', p_label; END IF;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

-- p_sql must raise SQLSTATE p_sqlstate (or any state in class p_sqlstate when it is 2 chars, e.g. '23') and the message must contain p_needle (a TRIM_E_ code for
-- function errors, a constraint / index name for table tripwires). The failed statement is rolled
-- back by the inner exception block, so it leaves nothing behind.
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

-- p_sql must succeed; its effects are rolled back either way (probe).
CREATE FUNCTION pg_temp.expect_ok(p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    BEGIN
      EXECUTE p_sql;
      RAISE EXCEPTION 'probe' USING ERRCODE = 'P0099';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN
      NULL;
    END;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
    RAISE EXCEPTION 'SMOKE FAIL (expected success): % -> got [%] %', p_label, v_state, v_msg;
  END;
  INSERT INTO pg_temp.smoke_log (label) VALUES (p_label);
END $$;

CREATE FUNCTION pg_temp.pay(p_flower_g numeric, p_rate numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT round(p_flower_g / 453.59237 * p_rate, 2) $$;

CREATE FUNCTION pg_temp.evn() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.trim_events $$;

-- SQL text builders so expect_err can drive the real functions (format %L renders NULL as NULL)
CREATE FUNCTION pg_temp.checkin_sql(
  p_co uuid, p_kind text, p_f numeric, p_t numeric, p_s numeric, p_status text,
  p_pct numeric, p_floor numeric, p_pay numeric, p_actor uuid, p_rem numeric, p_remp integer,
  p_fn text DEFAULT 'fn_trim_checkin'
) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.%s(%L::uuid,%L,%L::numeric,%L::numeric,%L::numeric,%L,%L::numeric,%L::numeric,%L::numeric,%L::uuid,%L::numeric,%L::integer)',
                p_fn, p_co, p_kind, p_f, p_t, p_s, p_status, p_pct, p_floor, p_pay, p_actor, p_rem, p_remp)
$$;

-- Cache invariant: for every load past 'hung', remaining == newest RETURNED episode's remaining,
-- else dry_g (and likewise for plants). Returns the number of violating loads (must be 0).
CREATE FUNCTION pg_temp.cache_violations() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.hanger_loads l
   WHERE l.dry_g IS NOT NULL
     AND ( l.remaining_g IS DISTINCT FROM
             coalesce((SELECT c.remaining_g FROM public.trim_checkouts c
                        WHERE c.load_id = l.id AND c.status = 'returned' ORDER BY c.seq DESC LIMIT 1), l.dry_g)
        OR l.remaining_plant_count IS DISTINCT FROM
             coalesce((SELECT c.remaining_plant_count FROM public.trim_checkouts c
                        WHERE c.load_id = l.id AND c.status = 'returned' ORDER BY c.seq DESC LIMIT 1), l.plant_count) )
$$;

-- raw trim_checkouts INSERT builder for the CHECK-tripwire tests (base: seq 91, issued 100 g, rate 1)
CREATE FUNCTION pg_temp.co_sql(p_load uuid, p_staff uuid, p_actor uuid, p_cols text, p_vals text) RETURNS text
LANGUAGE sql AS $$
  SELECT format('INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, issued_g, rate_per_lb_applied, checked_out_by, %s) VALUES (%L, 91, %L, %L, 100, 1, %L, %s)',
                p_cols, p_load, p_staff, 'raw', p_actor, p_vals)
$$;

DO $smoke$
DECLARE
  v_admin uuid; v_mgr uuid; v_ops uuid; v_cycle uuid; v_strain uuid; v_strain2 uuid;
  v_cycle_sum text;
  v_batchA uuid; v_batchB uuid; v_batchC uuid; v_unlinked uuid;
  v_h1 uuid; v_h2 uuid; v_h3 uuid; v_h4 uuid; v_h5 uuid; v_h6 uuid;
  v_staffA uuid; v_staffB uuid; v_staffInactive uuid;
  v_r jsonb; v_row public.hanger_loads;
  v_load1 uuid; v_load2 uuid; v_load3 uuid; v_load4 uuid; v_load5 uuid;
  v_ep1 uuid; v_ep2 uuid; v_ep3 uuid; v_co3a uuid; v_co3b uuid;
  v_ev bigint; v_n bigint; v_txt text;
  v_pct numeric := 5.00; v_floor numeric := 25.00;
  v_other_cycle uuid;
  v_load6 uuid; v_co6 uuid; v_raised boolean; v_state text; v_msg text;
BEGIN
  -- ============================ fixtures (borrowed, never modified) ============================
  SELECT id INTO v_admin FROM public.users WHERE role = 'admin' LIMIT 1;
  SELECT id INTO v_mgr   FROM public.users WHERE role = 'management' LIMIT 1;
  SELECT id INTO v_ops   FROM public.users WHERE role NOT IN ('admin','management') LIMIT 1;
  SELECT id, md5(room_cycles::text) INTO v_cycle, v_cycle_sum
    FROM public.room_cycles WHERE status = 'active' AND harvest_date IS NOT NULL LIMIT 1;
  SELECT id INTO v_strain  FROM public.strains ORDER BY id LIMIT 1;
  SELECT id INTO v_strain2 FROM public.strains ORDER BY id OFFSET 1 LIMIT 1;
  v_strain2 := coalesce(v_strain2, v_strain);
  IF v_admin IS NULL OR v_ops IS NULL OR v_cycle IS NULL OR v_strain IS NULL THEN
    RAISE EXCEPTION 'SMOKE SETUP: needs an admin user, an ordinary (non-admin, non-management) user, an active room_cycle with a harvest_date and a strain';
  END IF;

  -- ============================ privileges / RLS ============================
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.fn_trim_checkin(uuid,text,numeric,numeric,numeric,text,numeric,numeric,numeric,uuid,numeric,integer)', 'EXECUTE'), 'anon cannot execute fn_trim_checkin');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.fn_trim_void(uuid,text,uuid)', 'EXECUTE'), 'authenticated cannot execute fn_trim_void');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.fn_trim_void(uuid,text,uuid)', 'EXECUTE'), 'service_role can execute fn_trim_void');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.fn_create_hangers(text,integer,integer,integer,uuid)', 'EXECUTE'), 'authenticated cannot execute fn_create_hangers');
  PERFORM pg_temp.ok(NOT has_table_privilege('anon', 'public.hanger_loads', 'SELECT'), 'anon has no table access');
  PERFORM pg_temp.ok(NOT has_table_privilege('authenticated', 'public.trim_events', 'INSERT'), 'authenticated has no table access');
  SELECT count(*) INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('trim_settings','trim_staff','hangers','hanger_loads','trim_checkouts','trim_pay_entries','trim_events')
     AND c.relrowsecurity;
  PERFORM pg_temp.ok(v_n = 7, 'RLS enabled on all 7 tables');

  -- ============================ settings singleton ============================
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_settings) = 1, 'trim_settings seeded with exactly one row');
  PERFORM pg_temp.expect_err('INSERT INTO public.trim_settings (id) VALUES (false)', '23514', 'trim_settings_id_check', 'settings singleton: id=false rejected');
  PERFORM pg_temp.expect_err('INSERT INTO public.trim_settings (id) VALUES (true)', '23505', 'trim_settings_pkey', 'settings singleton: second row rejected');
  PERFORM pg_temp.expect_err('UPDATE public.trim_settings SET variance_pct_threshold = 101', '23514', 'trim_settings_variance_pct_threshold_check', 'settings: pct threshold > 100 rejected');

  -- ============================ hangers: seeder, lpad overflow, label_seq ============================
  PERFORM pg_temp.ok(lpad('1000', 3, '0') = '100', 'premise: lpad silently TRUNCATES 1000 to 100 (the bug being guarded)');
  v_ev := pg_temp.evn();
  v_r := public.fn_create_hangers('ZZ1-', 1, 5, 3, v_ops);
  PERFORM pg_temp.ok((v_r->>'inserted')::int = 5 AND (v_r->>'skipped')::int = 0 AND v_r->'codes'->>0 = 'ZZ1-001', 'create_hangers: 5 inserted, codes returned');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'create_hangers: exactly one event');
  v_r := public.fn_create_hangers('ZZ1-', 1, 5, 3, v_ops);
  PERFORM pg_temp.ok((v_r->>'inserted')::int = 0 AND (v_r->>'skipped')::int = 5, 'create_hangers: re-run is an idempotent no-op');
  v_r := public.fn_create_hangers('ZZ1-', 3, 5, 3, v_ops);
  PERFORM pg_temp.ok((v_r->>'inserted')::int = 2 AND (v_r->>'skipped')::int = 3, 'create_hangers: overlapping range 3..7 extends the fleet (2 new, 3 skipped)');
  v_r := public.fn_create_hangers('ZZ2-', 999, 1, 3, v_ops);
  PERFORM pg_temp.ok(v_r->'codes'->>0 = 'ZZ2-999', 'create_hangers: 999 fits in 3 digits');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1000,1,3,%L)', 'ZZ2-', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_hangers: 1000 in 3 digits RAISES (lpad overflow)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,999,2,3,%L)', 'ZZ2-', v_ops), 'P0001', 'does not fit', 'create_hangers: range crossing 999 RAISES');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1000,3,%L)', 'ZZ2-', v_ops), 'P0001', 'does not fit', 'create_hangers: count 1000 from 1 in 3 digits RAISES');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1,2,%L)', 'ZZ2-', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_hangers: digits < 3 rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,0,3,%L)', 'ZZ2-', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_hangers: count 0 rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1001,6,%L)', 'ZZ2-', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_hangers: count > 1000 rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1,3,%L)', 'zz2', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_hangers: malformed prefix rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1,3,NULL)', 'ZZ2-'), 'P0001', 'TRIM_E_INVALID', 'create_hangers: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_create_hangers(%L,1,1,4,%L)', 'ZZ1-', v_ops), 'P0001', 'different digit width', 'create_hangers: ZZ1-0001 cannot coexist with ZZ1-001');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq) VALUES ('ZZ1-100', 1000)$$, '23514', 'hangers_seq_matches_code', 'hangers: truncated code (label_seq 1000 vs ZZ1-100) rejected by CHECK');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq) VALUES ('ZZ1-0001', 1)$$, '23505', 'uidx_hangers_prefix_seq', 'hangers: same (prefix, number) at a different width rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq) VALUES ('ZZ1-001', 1)$$, '23505', 'hangers_code_key', 'hangers: duplicate code rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq) VALUES ('zz9-001', 1)$$, '23514', 'hangers_code_check', 'hangers: lower-case / malformed code rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq) VALUES ('ZZ9-12', 12)$$, '23514', 'hangers_code_check', 'hangers: too few digits rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.hangers (code, label_seq, status) VALUES ('ZZ9-001', 1, 'stolen')$$, '23514', 'hangers_status_check', 'hangers: bad status rejected');
  PERFORM pg_temp.expect_ok($$INSERT INTO public.hangers (code, label_seq) VALUES ('ZZ3-001', 1)$$, 'hangers: a second fleet may reuse number 001 under another prefix');

  SELECT id INTO v_h1 FROM public.hangers WHERE code = 'ZZ1-001';
  SELECT id INTO v_h2 FROM public.hangers WHERE code = 'ZZ1-002';
  SELECT id INTO v_h3 FROM public.hangers WHERE code = 'ZZ1-003';
  SELECT id INTO v_h4 FROM public.hangers WHERE code = 'ZZ1-004';
  SELECT id INTO v_h5 FROM public.hangers WHERE code = 'ZZ1-005';
  SELECT id INTO v_h6 FROM public.hangers WHERE code = 'ZZ1-006';

  -- ============================ trim staff ============================
  INSERT INTO public.trim_staff (full_name, pay_per_lb, created_by) VALUES ('Smoke Trimmer A', 200, v_ops) RETURNING id INTO v_staffA;
  INSERT INTO public.trim_staff (full_name, display_name, pay_per_lb, created_by) VALUES ('Smoke Trimmer B', 'Bee', 250, v_ops) RETURNING id INTO v_staffB;
  INSERT INTO public.trim_staff (full_name, pay_per_lb, is_active, created_by) VALUES ('Smoke Trimmer Gone', 100, false, v_ops) RETURNING id INTO v_staffInactive;
  PERFORM pg_temp.expect_err($$INSERT INTO public.trim_staff (full_name, pay_per_lb) VALUES ('x', 1001)$$, '23514', 'trim_staff_pay_per_lb_check', 'staff: rate > 1000 rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.trim_staff (full_name, pay_per_lb) VALUES ('y', -1)$$, '23514', 'trim_staff_pay_per_lb_check', 'staff: negative rate rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.trim_staff (full_name, pay_per_lb) VALUES ('   ', 1)$$, '23514', 'trim_staff_full_name_check', 'staff: blank name rejected');
  PERFORM pg_temp.expect_err($$INSERT INTO public.trim_staff (full_name, pay_per_lb) VALUES ('  smoke TRIMMER a ', 1)$$, '23505', 'uidx_trim_staff_active_name', 'staff: duplicate ACTIVE name (case/space-insensitive) rejected');
  PERFORM pg_temp.expect_ok($$INSERT INTO public.trim_staff (full_name, pay_per_lb) VALUES ('Smoke Trimmer Gone', 1)$$, 'staff: a name already used only by an inactive row is allowed');

  -- ============================ declare batches (R2.5) ============================
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_declare_batches(v_cycle,
           jsonb_build_array(jsonb_build_object('strain_id', v_strain, 'name', 'ZZSMK-A'),
                             jsonb_build_object('strain_id', v_strain2, 'name', 'ZZSMK-B', 'harvest_date', '2026-10-02'),
                             jsonb_build_object('strain_id', v_strain, 'name', 'ZZSMK-C')), v_ops);
  PERFORM pg_temp.ok(jsonb_array_length(v_r->'created') = 3 AND jsonb_array_length(v_r->'skipped') = 0, 'declare_batches: 3 created');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'declare_batches: exactly one event for the whole call');
  SELECT id INTO v_batchA FROM public.batches WHERE name = 'ZZSMK-A';
  SELECT id INTO v_batchB FROM public.batches WHERE name = 'ZZSMK-B';
  SELECT id INTO v_batchC FROM public.batches WHERE name = 'ZZSMK-C';
  PERFORM pg_temp.ok((SELECT NOT is_active AND room_cycle_id = v_cycle FROM public.batches WHERE id = v_batchA), 'declare_batches: created inactive and linked to the cycle');
  PERFORM pg_temp.ok((SELECT harvest_date = DATE '2026-10-02' FROM public.batches WHERE id = v_batchB), 'declare_batches: explicit harvest_date honoured');
  PERFORM pg_temp.ok((SELECT harvest_date IS NOT DISTINCT FROM (SELECT harvest_date FROM public.room_cycles WHERE id = v_cycle) FROM public.batches WHERE id = v_batchA), 'declare_batches: harvest_date defaults from the cycle (read-only)');
  v_r := public.fn_trim_declare_batches(v_cycle, jsonb_build_array(jsonb_build_object('strain_id', v_strain, 'name', 'ZZSMK-A')), v_ops);
  PERFORM pg_temp.ok(jsonb_array_length(v_r->'created') = 0 AND jsonb_array_length(v_r->'skipped') = 1, 'declare_batches: idempotent per cycle (re-declare skips)');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"%s","name":"ZZSMK-A"}]'::jsonb, %L)$f$, v_cycle, v_strain2, v_ops), 'P0001', 'TRIM_E_DUPLICATE_NAME', 'declare_batches: same name, different strain rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"%s","name":"zzsmk-a"}]'::jsonb, %L)$f$, v_cycle, v_strain, v_ops), 'P0001', 'TRIM_E_DUPLICATE_NAME', 'declare_batches: case-variant of an existing name rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"%s","name":"ZZSMK-N"},{"strain_id":"%s","name":"zzsmk-n"}]'::jsonb, %L)$f$, v_cycle, v_strain, v_strain, v_ops), 'P0001', 'TRIM_E_INVALID', 'declare_batches: duplicate name inside one request rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"not-a-uuid","name":"ZZSMK-N"}]'::jsonb, %L)$f$, v_cycle, v_ops), 'P0001', 'TRIM_E_INVALID', 'declare_batches: bad strain uuid rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"00000000-0000-0000-0000-000000000001","name":"ZZSMK-N"}]'::jsonb, %L)$f$, v_cycle, v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'declare_batches: unknown strain rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[]'::jsonb, %L)$f$, v_cycle, v_ops), 'P0001', 'TRIM_E_INVALID', 'declare_batches: empty array rejected');
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches('00000000-0000-0000-0000-000000000001', '[{"strain_id":"%s","name":"ZZSMK-N"}]'::jsonb, %L)$f$, v_strain, v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'declare_batches: unknown cycle rejected');
  -- atomic: a bad second element must leave NO batch from the first
  PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"%s","name":"ZZSMK-ATOM"},{"strain_id":"%s","name":"ZZSMK-A"}]'::jsonb, %L)$f$, v_cycle, v_strain, v_strain2, v_ops), 'P0001', 'TRIM_E_DUPLICATE_NAME', 'declare_batches: failing element aborts the call');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.batches WHERE name = 'ZZSMK-ATOM'), 'declare_batches: atomic - first element not left behind');
  SELECT id INTO v_other_cycle FROM public.room_cycles WHERE status <> 'active' LIMIT 1;
  IF v_other_cycle IS NOT NULL THEN
    PERFORM pg_temp.expect_err(format($f$SELECT public.fn_trim_declare_batches(%L, '[{"strain_id":"%s","name":"ZZSMK-N"}]'::jsonb, %L)$f$, v_other_cycle, v_strain, v_ops), 'P0001', 'TRIM_E_STATE', 'declare_batches: non-active cycle rejected');
  END IF;
  PERFORM pg_temp.ok((SELECT md5(room_cycles::text) FROM public.room_cycles WHERE id = v_cycle) = v_cycle_sum, 'declare_batches never writes room_cycles');
  INSERT INTO public.batches (name, strain_id, is_active) VALUES ('ZZSMK-UNLINKED', v_strain, false) RETURNING id INTO v_unlinked;

  -- ============================ create_load (transitions 1 / 1b) ============================
  v_ev := pg_temp.evn();
  v_row := public.fn_trim_create_load(v_h1, v_batchA, 10, 5000, NULL, 'harvest', v_ops);
  v_load1 := v_row.id;
  PERFORM pg_temp.ok(v_row.status = 'hung' AND v_row.wet_g = 5000 AND v_row.remaining_g IS NULL AND v_row.remaining_plant_count = 10 AND v_row.wet_recorded_by = v_ops, 'create_load: harvest weigh-in -> hung');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'create_load: exactly one event');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,10,5000,NULL,%L,%L)', v_h1, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_DUPLICATE_OPEN', 'create_load: second open load on a hanger rejected');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'create_load: failed call writes no event');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.hanger_loads (hanger_id, batch_id, status, wet_g, wet_recorded_at) VALUES (%L, %L, 'hung', 100, now())$f$, v_h1, v_batchA), '23505', 'uidx_hanger_loads_one_open_per_hanger', 'UNIQUE INDEX: one open load per hanger (raw insert)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,10,5000,NULL,%L,%L)', v_h2, v_unlinked, 'harvest', v_ops), 'P0001', 'TRIM_E_BATCH_REQUIRED', 'create_load: harvest weigh-in on an undeclared batch rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,10,NULL,NULL,%L,%L)', v_h2, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: harvest needs a wet weight');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,10,5000,900,%L,%L)', v_h2, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: harvest cannot carry a dry weight');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,0,5000,NULL,%L,%L)', v_h2, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: plant count 0 rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,501,5000,NULL,%L,%L)', v_h2, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: plant count 501 rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,-1,NULL,%L,%L)', v_h2, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: negative wet rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,NULL,NULL,NULL,%L,%L)', v_h2, v_unlinked, 'trim_station', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: late entry needs a dry weight');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,%L)', v_h2, v_batchA, 'nonsense', v_ops), 'P0001', 'TRIM_E_INVALID', 'create_load: bad source rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,NULL)', v_h2, v_batchA, 'harvest'), 'P0001', 'TRIM_E_INVALID', 'create_load: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,%L)', '00000000-0000-0000-0000-000000000001', v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'create_load: unknown hanger rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,%L)', v_h2, '00000000-0000-0000-0000-000000000001', 'harvest', v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'create_load: unknown batch rejected');
  IF v_other_cycle IS NOT NULL THEN
    INSERT INTO public.batches (name, strain_id, is_active, room_cycle_id) VALUES ('ZZSMK-CLOSED', v_strain, false, v_other_cycle) RETURNING id INTO v_txt;
    PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,%L)', v_h2, v_txt, 'harvest', v_ops), 'P0001', 'TRIM_E_BATCH_REQUIRED', 'create_load: harvest weigh-in on a batch whose cycle is not active rejected');
  END IF;
  UPDATE public.hangers SET status = 'retired' WHERE id = v_h5;
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_create_load(%L,%L,5,5000,NULL,%L,%L)', v_h5, v_batchA, 'harvest', v_ops), 'P0001', 'TRIM_E_STATE', 'create_load: retired hanger rejected');
  -- late entry: undeclared batch is fine, wet/plants optional, born 'dried'
  v_row := public.fn_trim_create_load(v_h2, v_unlinked, NULL, NULL, 1000, 'trim_station', v_ops);
  v_load2 := v_row.id;
  PERFORM pg_temp.ok(v_row.status = 'dried' AND v_row.dry_g = 1000 AND v_row.remaining_g = 1000 AND v_row.remaining_plant_count IS NULL AND v_row.wet_g IS NULL, 'create_load: late entry -> dried, remaining seeded from dry, exempt from the cycle gate');

  -- ============================ hanger_loads CHECK tripwires ============================
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'dried' WHERE id = %L$f$, v_load1), '23514', 'loads_post_dry', 'CHECK loads_post_dry: dried needs a dry weight');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET dry_g = 5 WHERE id = %L$f$, v_load1), '23514', 'loads_dry_pair', 'CHECK loads_dry_pair');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET wet_g = NULL WHERE id = %L$f$, v_load1), '23514', 'loads_hung_has_wet', 'CHECK loads_hung_has_wet');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET remaining_plant_count = 11 WHERE id = %L$f$, v_load1), '23514', 'loads_remaining_plants_le', 'CHECK loads_remaining_plants_le: remaining plants cannot exceed plant_count');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET remaining_g = 1000.01 WHERE id = %L$f$, v_load2), '23514', 'loads_remaining_le_dry', 'CHECK loads_remaining_le_dry: remaining cannot exceed dry');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET remaining_g = NULL WHERE id = %L$f$, v_load2), '23514', 'loads_remaining_set', 'CHECK loads_remaining_set: remaining NOT NULL once dried');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'partial', remaining_g = 0, remaining_plant_count = 0 WHERE id = %L$f$, v_load2), '23514', 'loads_partial', 'CHECK loads_partial: partial implies remaining > 0');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'partial', remaining_plant_count = NULL WHERE id = %L$f$, v_load2), '23514', 'loads_partial', 'CHECK loads_partial: partial implies plants >= 1');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'reconciled', reconciled_at = now() WHERE id = %L$f$, v_load2), '23514', 'loads_reconciled', 'CHECK loads_reconciled: reconciled implies remaining = 0');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'void', voided_at = now() WHERE id = %L$f$, v_load2), '23514', 'loads_void', 'CHECK loads_void: void needs a reason');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET status = 'bogus' WHERE id = %L$f$, v_load2), '23514', 'hanger_loads_status_check', 'CHECK status enum');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET dry_g = 0, dry_recorded_at = now() WHERE id = %L$f$, v_load2), '23514', 'hanger_loads_dry_g_check', 'CHECK dry_g > 0');
  PERFORM pg_temp.expect_err(format($f$UPDATE public.hanger_loads SET plant_count = 501 WHERE id = %L$f$, v_load2), '23514', 'hanger_loads_plant_count_check', 'CHECK plant_count <= 500');

  -- ============================ dry / wet corrections (transitions 2, 3) ============================
  v_ev := pg_temp.evn();
  v_row := public.fn_trim_record_dry(v_load1, 1200, v_ops);
  PERFORM pg_temp.ok(v_row.status = 'dried' AND v_row.dry_g = 1200 AND v_row.remaining_g = 1200 AND v_row.remaining_plant_count = 10, 'record_dry: hung -> dried, remaining seeded');
  PERFORM pg_temp.ok((SELECT event_type FROM public.trim_events ORDER BY id DESC LIMIT 1) = 'dry_recorded' AND pg_temp.evn() = v_ev + 1, 'record_dry: one dry_recorded event');
  v_row := public.fn_trim_record_dry(v_load1, 1250, v_ops);
  PERFORM pg_temp.ok(v_row.status = 'dried' AND v_row.dry_g = 1250 AND v_row.remaining_g = 1250, 'record_dry: in-place correction re-seeds remaining');
  PERFORM pg_temp.ok((SELECT event_type FROM public.trim_events ORDER BY id DESC LIMIT 1) = 'dry_corrected', 'record_dry: second call is a dry_corrected event');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_record_dry(%L,0,%L)', v_load1, v_ops), 'P0001', 'TRIM_E_INVALID', 'record_dry: zero weight rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_record_dry(%L,100,NULL)', v_load1), 'P0001', 'TRIM_E_INVALID', 'record_dry: actor required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_record_dry(%L,100,%L)', '00000000-0000-0000-0000-000000000001', v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'record_dry: unknown load');
  v_row := public.fn_trim_correct_wet(v_load1, 5100, 12, v_ops);
  PERFORM pg_temp.ok(v_row.wet_g = 5100 AND v_row.plant_count = 12 AND v_row.remaining_plant_count = 12, 'correct_wet: wet + plant count corrected while dried; cache follows plants');
  v_row := public.fn_trim_correct_wet(v_load1, NULL, 10, v_ops);
  PERFORM pg_temp.ok(v_row.wet_g = 5100 AND v_row.plant_count = 10 AND v_row.remaining_plant_count = 10, 'correct_wet: NULL leaves wet untouched');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_correct_wet(%L,NULL,NULL,%L)', v_load1, v_ops), 'P0001', 'TRIM_E_INVALID', 'correct_wet: nothing to change rejected');
  v_row := public.fn_trim_correct_wet(v_load2, 3000, 8, v_ops);
  PERFORM pg_temp.ok(v_row.wet_g = 3000 AND v_row.wet_recorded_at IS NOT NULL AND v_row.remaining_plant_count = 8, 'correct_wet: late wet entry for a trim_station load');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant holds after dry/wet corrections');

  -- ============================ 3-episode partial chain on load1 ============================
  -- dry 1250 g, 10 plants.  A (200/lb) -> unfinished;  B (250/lb) -> unfinished, FLAGGED, resolved;
  -- A again (raised to 220/lb) -> complete.
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_checkout(v_load1, v_staffA, NULL, v_ops);
  v_ep1 := (v_r->'checkout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'checkout'->>'seq')::int = 1 AND (v_r->'checkout'->>'issued_g')::numeric = 1250 AND (v_r->'checkout'->>'issued_plant_count')::int = 10
                     AND (v_r->'checkout'->>'rate_per_lb_applied')::numeric = 200 AND v_r->'load'->>'status' = 'checked_out', 'ep1 checkout: seq 1, issues 1250 g / 10 plants, rate snapshotted');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'checkout: exactly one event');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load1, v_staffB, v_ops), 'P0001', 'TRIM_E_ALREADY_OUT', 'checkout: a second checkout of an out load rejected (ALREADY_OUT)');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, status, issued_g, rate_per_lb_applied, checked_out_by) VALUES (%L, 2, %L, 'x', 'out', 10, 1, %L)$f$, v_load1, v_staffB, v_ops), '23505', 'uidx_trim_checkouts_one_out_per_load', 'UNIQUE INDEX: one out checkout per load (raw insert)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load1, 'trying to void it', v_ops), 'P0001', 'TRIM_E_STATE', 'void: a checked-out load cannot be voided');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_record_dry(%L,100,%L)', v_load1, v_ops), 'P0001', 'TRIM_E_STATE', 'record_dry: refused once checked out');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_correct_wet(%L,NULL,9,%L)', v_load1, v_ops), 'P0001', 'TRIM_E_STATE', 'correct_wet: plant count frozen once checked out');
  -- argument validation on check-in
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'bogus',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: bad return kind');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,6), 'P0001', 'TRIM_E_INVALID', 'checkin: unfinished needs remaining weight');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,0,6), 'P0001', 'TRIM_E_INVALID', 'checkin: unfinished remaining must be > 0');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,1250,6), 'P0001', 'TRIM_E_INVALID', 'checkin: remaining == issued rejected (monotonic)');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,2000,6), 'P0001', 'TRIM_E_INVALID', 'checkin: remaining > issued rejected (monotonic)');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: unfinished needs plants left');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,0), 'P0001', 'TRIM_E_INVALID', 'checkin: unfinished plants left must be >= 1');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,11), 'P0001', 'TRIM_E_INVALID', 'checkin: plants left > plants issued rejected');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,5,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: complete cannot carry remaining weight');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,2), 'P0001', 'TRIM_E_INVALID', 'checkin: complete cannot carry remaining plants');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',-1,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: negative bucket rejected');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',NULL,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: missing bucket rejected');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'maybe',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: bad variance status');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'ok',v_pct,v_floor,NULL,v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: ok needs a pay amount');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'ok',NULL,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: threshold snapshot required');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),NULL,NULL,NULL), 'P0001', 'TRIM_E_INVALID', 'checkin: actor required');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql('00000000-0000-0000-0000-000000000001',   'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_NOT_FOUND', 'checkin: unknown checkout');
  -- DB tripwires behind the function (each must name its own constraint)
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,500,6), '23514', 'co_ok_within_threshold', 'CHECK co_ok_within_threshold: an ok its own snapshot says is out of threshold is refused');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200) + 1,v_ops,800,6), '23514', 'pay_amount_matches', 'CHECK pay_amount_matches: TS/SQL pay drift refused');
  PERFORM pg_temp.ok((SELECT status FROM public.trim_checkouts WHERE id = v_ep1) = 'out', 'failed check-ins left the episode out (sub-transaction rolled back)');

  -- ---- episode 1: A returns UNFINISHED, within threshold -> load 'partial' ----
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_checkin(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,6);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial' AND (v_r->'load'->>'remaining_g')::numeric = 800 AND (v_r->'load'->>'remaining_plant_count')::int = 6, 'ep1 check-in unfinished+ok -> load partial, cache = 800 g / 6 plants');
  PERFORM pg_temp.ok((v_r->'checkout'->>'processed_g')::numeric = 450 AND (v_r->'checkout'->>'variance_g')::numeric = 0 AND (v_r->'checkout'->>'variance_pct')::numeric = 0 AND (v_r->'checkout'->>'plants_finished')::int = 4 AND v_r->'checkout'->>'return_kind' = 'unfinished', 'ep1 generated columns: processed 450, variance 0, 4 plants finished');
  PERFORM pg_temp.ok((v_r->'pay_entry'->>'amount')::numeric = pg_temp.pay(300,200) AND v_r->'pay_entry'->>'status' = 'open', 'ep1 pay entry written (open) at the snapshotted rate');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'check-in: exactly one event');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after ep1');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,6), 'P0001', 'TRIM_E_STATE', 'check-in: an already-returned episode cannot be checked in again');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_pay_entries WHERE checkout_id = v_ep1) = 1 AND (SELECT flower_g FROM public.trim_checkouts WHERE id = v_ep1) = 300, 'check-in twice: no second pay entry, original weights untouched');

  -- ---- episode 2: reissue to B (partial counts as open and is reissuable) ----
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,800,%L)', v_load1, v_staffB, v_ops), 'P0001', 'TRIM_E_INVALID', 'checkout: dry weight only accepted while hung');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load1, v_staffInactive, v_ops), 'P0001', 'TRIM_E_INVALID', 'checkout: inactive trimmer rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load1, '00000000-0000-0000-0000-000000000001', v_ops), 'P0001', 'TRIM_E_NOT_FOUND', 'checkout: unknown trimmer rejected');
  v_r := public.fn_trim_checkout(v_load1, v_staffB, NULL, v_ops);
  v_ep2 := (v_r->'checkout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'checkout'->>'seq')::int = 2 AND (v_r->'checkout'->>'issued_g')::numeric = 800 AND (v_r->'checkout'->>'issued_plant_count')::int = 6
                     AND (v_r->'checkout'->>'rate_per_lb_applied')::numeric = 250 AND v_r->'checkout'->>'trimmer_name' = 'Bee', 'ep2 checkout: seq 2 issues the REMAINING 800 g / 6 plants to B at B''s rate (display name used)');
  -- ep2 comes back unfinished AND flagged: 200+70+40 + 450 left = 760 of 800 -> 40 g / 11.429% of the 350 g processed
  v_r := public.fn_trim_checkin(v_ep2,'unfinished',200,70,40,'flagged',v_pct,v_floor,NULL,v_ops,450,3);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'returned' AND (v_r->'load'->>'remaining_g')::numeric = 450 AND (v_r->'load'->>'remaining_plant_count')::int = 3, 'ep2 flagged unfinished -> load returned (not partial), cache already = 450 g / 3');
  PERFORM pg_temp.ok((v_r->'checkout'->>'variance_g')::numeric = 40 AND (v_r->'checkout'->>'processed_g')::numeric = 350 AND (v_r->'checkout'->>'variance_pct')::numeric = 11.429, 'ep2 four-bucket variance: 40 g over processed_g 350 (not issued_g) = 11.429%');
  PERFORM pg_temp.ok(v_r->'pay_entry' = 'null'::jsonb AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE checkout_id = v_ep2), 'ep2 flagged: no pay entry yet');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after ep2 (flagged)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load1, v_staffA, v_ops), 'P0001', 'flagged', 'checkout: a flagged unfinished return BLOCKS reissue');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load1, 'no longer needed', v_ops), 'P0001', 'TRIM_E_STATE', 'void: a flagged returned load cannot be voided');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_release(%L,%L,%L)', v_ep2, 'nope nope', v_ops), 'P0001', 'TRIM_E_STATE', 'release: only an out checkout can be released');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen(%L,%L,%L)', v_load1, 'not reconciled', v_ops), 'P0001', 'TRIM_E_STATE', 'reopen: only a reconciled load');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep1,'unfinished',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,800,6,'fn_trim_correct_return'), 'P0001', 'newest returned episode', 'correct_return: an OLDER episode (ep1) is immutable');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_resolve_variance(%L,%L,%L,%L)', v_ep2, 'ok', pg_temp.pay(200,250), v_ops), 'P0001', 'TRIM_E_INVALID', 'resolve: reason under 3 chars rejected');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_resolve_variance(%L,%L,NULL,%L)', v_ep2, 'double counted bin', v_ops), 'P0001', 'TRIM_E_INVALID', 'resolve: pay amount required');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_resolve_variance(%L,%L,%L,%L)', v_ep1, 'double counted bin', pg_temp.pay(300,200), v_ops), 'P0001', 'TRIM_E_STATE', 'resolve: not a flagged episode');
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_resolve_variance(v_ep2, 'double counted the bin, accept', pg_temp.pay(200,250), v_ops);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial' AND v_r->'checkout'->>'variance_status' = 'accepted' AND (v_r->'checkout'->>'variance_accepted_by')::uuid = v_ops, 'resolve: flagged unfinished -> accepted, load back to partial (reissuable)');
  PERFORM pg_temp.ok((v_r->'pay_entry'->>'amount')::numeric = pg_temp.pay(200,250), 'resolve: pay entry created at the episode''s own rate');
  PERFORM pg_temp.ok(pg_temp.evn() = v_ev + 1, 'resolve: exactly one event');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_resolve_variance(%L,%L,%L,%L)', v_ep2, 'accept it again', pg_temp.pay(200,250), v_ops), 'P0001', 'TRIM_E_STATE', 'resolve: load no longer returned');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after resolve');

  -- ---- episode 3: A is given a raise AFTER ep1 was issued; ep3 snapshots the new rate; COMPLETE ----
  UPDATE public.trim_staff SET pay_per_lb = 220 WHERE id = v_staffA;
  v_r := public.fn_trim_checkout(v_load1, v_staffA, NULL, v_ops);
  v_ep3 := (v_r->'checkout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'checkout'->>'seq')::int = 3 AND (v_r->'checkout'->>'issued_g')::numeric = 450 AND (v_r->'checkout'->>'issued_plant_count')::int = 3 AND (v_r->'checkout'->>'rate_per_lb_applied')::numeric = 220, 'ep3 checkout: seq 3 issues 450 g / 3 plants at the NEW rate');
  PERFORM pg_temp.ok((SELECT rate_per_lb_applied FROM public.trim_checkouts WHERE id = v_ep1) = 200, 'rate snapshot: ep1 keeps 200 after the raise');
  v_r := public.fn_trim_checkin(v_ep3,'complete',300,100,45,'ok',v_pct,v_floor,pg_temp.pay(300,220),v_ops,NULL,NULL);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'reconciled' AND (v_r->'load'->>'remaining_g')::numeric = 0 AND (v_r->'load'->>'remaining_plant_count')::int = 0 AND v_r->'load'->>'reconciled_at' IS NOT NULL, 'ep3 complete+ok -> load reconciled, remaining 0 / 0');
  PERFORM pg_temp.ok((v_r->'checkout'->>'variance_g')::numeric = 5 AND (v_r->'checkout'->>'processed_g')::numeric = 450 AND (v_r->'checkout'->>'variance_pct')::numeric = 1.111 AND (v_r->'checkout'->>'plants_finished')::int = 3, 'ep3: a complete return is the v1 equation (processed = issued)');
  PERFORM pg_temp.ok((SELECT array_agg(seq ORDER BY seq) FROM public.trim_checkouts WHERE load_id = v_load1) = ARRAY[1,2,3], 'GAPLESS seq: 1,2,3');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_checkouts WHERE load_id = v_load1 AND status = 'returned' AND return_kind = 'complete') = 1, 'exactly ONE complete return on the load');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_pay_entries WHERE checkout_id IN (v_ep1, v_ep2, v_ep3)) = 3, 'one pay entry per returned episode (3)');
  PERFORM pg_temp.ok((SELECT sum(flower_g) FROM public.trim_pay_entries WHERE checkout_id IN (v_ep1, v_ep2, v_ep3)) = 800 AND (SELECT sum(flower_g) FROM public.trim_checkouts WHERE load_id = v_load1 AND status = 'returned') = 800, 'pay-entry flower sums to returned-episode flower (the Phase 3 close-batch tripwire holds)');
  PERFORM pg_temp.ok((SELECT bool_and(remaining_g < issued_g) FROM public.trim_checkouts WHERE load_id = v_load1 AND status = 'returned'), 'MONOTONIC: remaining < issued on every episode');
  PERFORM pg_temp.ok((SELECT bool_and(c.issued_g = coalesce(p.remaining_g, 1250)) FROM public.trim_checkouts c
                       LEFT JOIN public.trim_checkouts p ON p.load_id = c.load_id AND p.seq = c.seq - 1 WHERE c.load_id = v_load1),
                     'MONOTONIC: every episode is issued exactly what the previous one left (1250 -> 800 -> 450)');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after ep3 (reconciled)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load1, v_staffA, v_ops), 'P0001', 'TRIM_E_STATE', 'checkout: a complete episode is the last one (reconciled load refused)');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, status, issued_g, rate_per_lb_applied, checked_out_by, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied)
                                      VALUES (%L, 4, %L, 'x', 'returned', 100, 1, %L, 'complete', 40, 30, 30, 0, 0, now(), 'flagged', 5, 25)$f$, v_load1, v_staffA, v_ops), '23505', 'uidx_trim_checkouts_one_complete_per_load', 'UNIQUE INDEX: at most one COMPLETE return per load (raw insert)');
  PERFORM pg_temp.expect_ok(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, status, issued_g, rate_per_lb_applied, checked_out_by, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied)
                                      VALUES (%L, 4, %L, 'x', 'returned', 100, 1, %L, 'unfinished', 40, 30, 20, 10, 1, now(), 'flagged', 5, 25)$f$, v_load1, v_staffA, v_ops), 'UNIQUE INDEX control: a further UNFINISHED return is not blocked by the complete-only index');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, status, issued_g, rate_per_lb_applied, checked_out_by, released_at, release_reason)
                                      VALUES (%L, 3, %L, 'x', 'released', 10, 1, %L, now(), 'because')$f$, v_load1, v_staffA, v_ops), '23505', 'uidx_trim_checkouts_seq', 'UNIQUE(load_id, seq): duplicate episode number rejected');

  -- ---- reopen / correct / resolve on the newest episode ----
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen(%L,%L,%L)', v_load1, 'x', v_ops), 'P0001', 'TRIM_E_INVALID', 'reopen: reason required');
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_reopen(v_load1, 'recount needed', v_ops);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'returned' AND v_r->'load'->>'reconciled_at' IS NULL AND v_r->'checkout'->>'variance_status' = 'flagged' AND v_r->'checkout'->>'variance_reason' IS NULL, 'reopen: reconciled -> returned, episode flagged again');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE checkout_id = v_ep3) AND pg_temp.evn() = v_ev + 1, 'reopen: open pay entry deleted, one event');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen(%L,%L,%L)', v_load1, 'twice in a row', v_ops), 'P0001', 'TRIM_E_STATE', 'reopen: not reconciled any more');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep2,'unfinished',200,70,40,'ok',v_pct,v_floor,pg_temp.pay(200,250),v_ops,450,3,'fn_trim_correct_return'), 'P0001', 'newest returned episode', 'correct_return: ep2 is no longer the newest');
  -- the re-weigh turns out to be UNFINISHED after all (kind change)
  v_r := public.fn_trim_correct_return(v_ep3,'unfinished',250,80,40,'ok',v_pct,v_floor,pg_temp.pay(250,220),v_ops,80,1);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial' AND (v_r->'load'->>'remaining_g')::numeric = 80 AND (v_r->'load'->>'remaining_plant_count')::int = 1 AND v_r->'checkout'->>'return_kind' = 'unfinished' AND (v_r->'checkout'->>'plants_finished')::int = 2, 'correct_return: complete -> unfinished, load partial, cache follows (80 g / 1 plant)');
  PERFORM pg_temp.ok((v_r->'pay_entry'->>'amount')::numeric = pg_temp.pay(250,220), 'correct_return: pay entry recreated for the corrected flower');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after kind change to unfinished');
  -- plants-left == plants issued is legal (non-strict)
  v_r := public.fn_trim_correct_return(v_ep3,'unfinished',250,80,40,'ok',v_pct,v_floor,pg_temp.pay(250,220),v_ops,80,3);
  PERFORM pg_temp.ok((v_r->'checkout'->>'plants_finished')::int = 0 AND v_r->'load'->>'status' = 'partial', 'correct_return: remaining plants == issued plants is accepted (non-strict)');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep3,'unfinished',250,80,40,'ok',v_pct,v_floor,pg_temp.pay(250,220),v_ops,80,4,'fn_trim_correct_return'), 'P0001', 'TRIM_E_INVALID', 'correct_return: remaining plants > issued rejected');
  -- ... and back to complete: the pay entry is UPSERTED, not duplicated
  v_r := public.fn_trim_correct_return(v_ep3,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,220),v_ops,NULL,NULL);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'reconciled' AND (v_r->'load'->>'remaining_g')::numeric = 0, 'correct_return: back to complete -> reconciled');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_pay_entries WHERE checkout_id = v_ep3) = 1 AND (SELECT amount FROM public.trim_pay_entries WHERE checkout_id = v_ep3) = pg_temp.pay(300,220), 'correct_return: pay entry upserted in place (still exactly one)');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_ep3,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,220),v_ops,NULL,NULL,'fn_trim_correct_return'), 'P0001', 'reopen it', 'correct_return: a reconciled load must be reopened first');
  -- a flagged correction deletes the entry; resolving recreates it
  PERFORM public.fn_trim_reopen(v_load1, 'second recount', v_ops);
  v_r := public.fn_trim_correct_return(v_ep3,'complete',100,50,20,'flagged',v_pct,v_floor,NULL,v_ops,NULL,NULL);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'returned' AND NOT EXISTS (SELECT 1 FROM public.trim_pay_entries WHERE checkout_id = v_ep3), 'correct_return -> flagged: load returned, pay entry removed');
  v_r := public.fn_trim_resolve_variance(v_ep3, 'accepted after recount', pg_temp.pay(100,220), v_ops);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'reconciled' AND v_r->'checkout'->>'variance_status' = 'accepted' AND (v_r->'pay_entry'->>'amount')::numeric = pg_temp.pay(100,220), 'resolve on a complete flagged episode -> reconciled');
  -- once the entry leaves 'open' (batch closed / payout approved, Phase 3) the load is frozen
  UPDATE public.trim_pay_entries SET status = 'ready' WHERE checkout_id = v_ep3;
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_reopen(%L,%L,%L)', v_load1, 'too late to reopen', v_ops), 'P0001', 'already ready', 'reopen: refused once the pay entry is no longer open');
  UPDATE public.trim_pay_entries SET status = 'open' WHERE checkout_id = v_ep3;
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_events WHERE load_id = v_load1 AND event_type = 'checked_out') = 3
                 AND (SELECT count(*) FROM public.trim_events WHERE load_id = v_load1 AND event_type = 'checked_in') = 3
                 AND (SELECT count(*) FROM public.trim_events WHERE load_id = v_load1 AND event_type = 'variance_resolved') = 2
                 AND (SELECT count(*) FROM public.trim_events WHERE load_id = v_load1 AND event_type = 'reopened') = 2
                 AND (SELECT count(*) FROM public.trim_events WHERE load_id = v_load1 AND event_type = 'return_corrected') = 4,
                 'events: one row per call across the whole chain (3 out, 3 in, 2 resolved, 2 reopened, 4 corrected)');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant at the end of the load1 chain');

  -- ============================ release, partial-void (admin or management only), plain void ============================
  v_row := public.fn_trim_create_load(v_h3, v_batchB, 7, 4000, NULL, 'harvest', v_ops);
  v_load3 := v_row.id;
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load3, v_staffA, v_ops), 'P0001', 'TRIM_E_INVALID', 'checkout: a hung load needs its dry weight');
  v_r := public.fn_trim_checkout(v_load3, v_staffA, 900, v_ops);
  v_co3a := (v_r->'checkout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'load'->>'dry_g')::numeric = 900 AND (v_r->'load'->>'remaining_g')::numeric = 900 AND v_r->'load'->>'status' = 'checked_out', 'checkout of a hung load records dry weight inline (hung -> dried -> checked_out)');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_release(%L,%L,%L)', v_co3a, 'x', v_ops), 'P0001', 'TRIM_E_INVALID', 'release: reason required');
  v_ev := pg_temp.evn();
  v_r := public.fn_trim_release(v_co3a, 'trimmer went home sick', v_ops);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'dried' AND v_r->'checkout'->>'status' = 'released' AND pg_temp.evn() = v_ev + 1, 'release: no episode ever returned -> back to dried');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_release(%L,%L,%L)', v_co3a, 'again please', v_ops), 'P0001', 'TRIM_E_STATE', 'release: already released');
  PERFORM pg_temp.expect_err(pg_temp.checkin_sql(v_co3a,'complete',300,100,50,'ok',v_pct,v_floor,pg_temp.pay(300,200),v_ops,NULL,NULL), 'P0001', 'TRIM_E_STATE', 'check-in: a released checkout cannot be checked in');
  v_r := public.fn_trim_checkout(v_load3, v_staffB, NULL, v_ops);
  v_co3b := (v_r->'checkout'->>'id')::uuid;
  PERFORM pg_temp.ok((v_r->'checkout'->>'seq')::int = 2 AND (v_r->'checkout'->>'issued_g')::numeric = 900, 'a released episode keeps its seq; the next one is 2');
  v_r := public.fn_trim_checkin(v_co3b,'unfinished',250,100,50,'ok',v_pct,v_floor,pg_temp.pay(250,250),v_ops,500,4);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial' AND (v_r->'load'->>'remaining_g')::numeric = 500, 'load3 partial after an unfinished return');
  v_r := public.fn_trim_checkout(v_load3, v_staffA, NULL, v_ops);
  v_r := public.fn_trim_release((v_r->'checkout'->>'id')::uuid, 'swapped to a different task', v_ops);
  PERFORM pg_temp.ok(v_r->'load'->>'status' = 'partial' AND (v_r->'load'->>'remaining_g')::numeric = 500 AND (v_r->'checkout'->>'seq')::int = 3, 'release: an earlier episode returned -> back to PARTIAL, cache untouched');
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'cache invariant after release');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load3, 'abandoned lot', v_ops), 'P0001', 'TRIM_E_FORBIDDEN', 'void(partial): an ordinary ops user is FORBIDDEN');
  IF v_mgr IS NOT NULL THEN
    PERFORM pg_temp.expect_ok(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load3, 'management unsticks the batch', v_mgr), 'void(partial): a MANAGEMENT user is allowed (probe, rolled back)');
  END IF;
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load3, 'x', v_admin), 'P0001', 'TRIM_E_INVALID', 'void: reason required even for admin');
  v_ev := pg_temp.evn();
  v_row := public.fn_trim_void(v_load3, 'abandoned lot - admin override', v_admin);
  PERFORM pg_temp.ok(v_row.status = 'void' AND v_row.voided_by = v_admin AND v_row.void_reason = 'abandoned lot - admin override' AND pg_temp.evn() = v_ev + 1, 'void(partial): admin succeeds with a reason, one event');
  PERFORM pg_temp.ok((SELECT (payload->>'returned_episodes')::int FROM public.trim_events WHERE event_type = 'voided' ORDER BY id DESC LIMIT 1) = 1, 'void event records the returned-episode count');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_void(%L,%L,%L)', v_load3, 'void it twice', v_admin), 'P0001', 'TRIM_E_STATE', 'void: already void');
  PERFORM pg_temp.expect_err(format('SELECT public.fn_trim_checkout(%L,%L,NULL,%L)', v_load3, v_staffA, v_ops), 'P0001', 'TRIM_E_STATE', 'checkout: a void load is refused');
  v_row := public.fn_trim_create_load(v_h3, v_batchB, 5, 3000, NULL, 'harvest', v_ops);
  v_load5 := v_row.id;
  PERFORM pg_temp.ok(v_row.status = 'hung', 'void frees the hanger: a new open load on the same tag is allowed');
  v_row := public.fn_trim_create_load(v_h4, v_batchB, 5, 3000, NULL, 'harvest', v_ops);
  v_load4 := v_row.id;
  v_row := public.fn_trim_void(v_load4, 'weighed on the wrong hanger', v_ops);
  PERFORM pg_temp.ok(v_row.status = 'void', 'void(hung): ops role allowed');
  v_row := public.fn_trim_create_load(v_h4, v_unlinked, NULL, NULL, 800, 'trim_station', v_ops);
  v_row := public.fn_trim_void(v_row.id, 'duplicate of another hanger', v_ops);
  PERFORM pg_temp.ok(v_row.status = 'void', 'void(dried): ops role allowed');

  -- ============================ the row-count guards are LIVE (fn_trim_checkin predicates) ============================
  -- fn_trim_checkin's pre-checks make `AND status = 'out'` / `AND status = 'checked_out'` in its UPDATEs
  -- look redundant in one session, so a plain double check-in cannot prove them. Here we bypass the
  -- pre-check: inside a rolled-back sub-transaction we replace fn_trim_assert_return_args (called AFTER
  -- the pre-checks and BEFORE the UPDATEs) with a version that changes the row underneath, exactly like
  -- a concurrent writer that slipped past the lock. With the predicate the call must raise TRIM_E_STATE;
  -- without it the stale UPDATE would succeed and double-write. The function swap is DDL inside the
  -- sub-transaction, so it is undone with the rest of the probe.
  v_row := public.fn_trim_create_load(v_h6, v_batchB, 3, 2000, NULL, 'harvest', v_ops);
  v_load6 := v_row.id;
  v_r := public.fn_trim_checkout(v_load6, v_staffA, 600, v_ops);
  v_co6 := (v_r->'checkout'->>'id')::uuid;

  v_raised := false; v_state := NULL; v_msg := NULL;
  BEGIN
    EXECUTE format($x$CREATE OR REPLACE FUNCTION public.fn_trim_assert_return_args(
                         p_return_kind text, p_flower_g numeric, p_trim_g numeric, p_stems_g numeric, p_remaining_g numeric, p_remaining_plants integer,
                         p_issued_g numeric, p_issued_plants integer, p_variance_status text, p_flag_pct numeric, p_flag_floor_g numeric, p_pay_amount numeric)
                       RETURNS void LANGUAGE plpgsql AS $y$ BEGIN
                         UPDATE public.trim_checkouts SET status = 'released', released_at = now(), release_reason = 'sabotage' WHERE id = %L;
                       END $y$$x$, v_co6);
    BEGIN
      PERFORM public.fn_trim_checkin(v_co6,'complete',300,200,100,'ok',v_pct,v_floor,pg_temp.pay(300,220),v_ops,NULL,NULL);
    EXCEPTION WHEN OTHERS THEN
      v_raised := true; v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    RAISE EXCEPTION 'probe' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  PERFORM pg_temp.ok(v_raised AND v_state = 'P0001' AND position('TRIM_E_STATE' IN v_msg) > 0,
                     'ROW-COUNT GUARD: check-in UPDATE is guarded by "AND status = out" (a checkout changed mid-call raises TRIM_E_STATE; got ' || coalesce(v_state || ' ' || v_msg, 'NO ERROR') || ')');

  v_raised := false; v_state := NULL; v_msg := NULL;
  BEGIN
    EXECUTE format($x$CREATE OR REPLACE FUNCTION public.fn_trim_assert_return_args(
                         p_return_kind text, p_flower_g numeric, p_trim_g numeric, p_stems_g numeric, p_remaining_g numeric, p_remaining_plants integer,
                         p_issued_g numeric, p_issued_plants integer, p_variance_status text, p_flag_pct numeric, p_flag_floor_g numeric, p_pay_amount numeric)
                       RETURNS void LANGUAGE plpgsql AS $y$ BEGIN
                         UPDATE public.hanger_loads SET status = 'dried' WHERE id = %L;
                       END $y$$x$, v_load6);
    BEGIN
      PERFORM public.fn_trim_checkin(v_co6,'complete',300,200,100,'ok',v_pct,v_floor,pg_temp.pay(300,220),v_ops,NULL,NULL);
    EXCEPTION WHEN OTHERS THEN
      v_raised := true; v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    RAISE EXCEPTION 'probe' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  PERFORM pg_temp.ok(v_raised AND v_state = 'P0001' AND position('TRIM_E_STATE' IN v_msg) > 0,
                     'ROW-COUNT GUARD: check-in UPDATE is guarded by "AND status = checked_out" on the load (got ' || coalesce(v_state || ' ' || v_msg, 'NO ERROR') || ')');
  -- the sabotaged function only ever existed inside rolled-back probes: the real one is back
  PERFORM pg_temp.ok(pg_get_functiondef('public.fn_trim_assert_return_args(text,numeric,numeric,numeric,numeric,integer,numeric,integer,text,numeric,numeric,numeric)'::regprocedure) NOT LIKE '%sabotage%'
                     AND (SELECT status FROM public.trim_checkouts WHERE id = v_co6) = 'out'
                     AND (SELECT status FROM public.hanger_loads WHERE id = v_load6) = 'checked_out', 'probes rolled back cleanly: real helper restored, checkout still out, load still checked_out');

  -- ============================ trim_checkouts CHECK tripwires (raw inserts against load5) ============================
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, flower_g', $$'out', 5$$), '23514', 'co_out_clean', 'CHECK co_out_clean: an out episode carries no returned data');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status', $$'returned'$$), '23514', 'co_returned_complete', 'CHECK co_returned_complete: a returned episode must be fully populated');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'complete', 10, 10, 10, 5, 0, now(), 'flagged', 5, 25$$), '23514', 'co_kind_complete', 'CHECK co_kind_complete: complete means remaining 0');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'unfinished', 10, 10, 10, 0, 1, now(), 'flagged', 5, 25$$), '23514', 'co_kind_unfinished', 'CHECK co_kind_unfinished: unfinished means remaining > 0');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'unfinished', 10, 10, 10, 100, 1, now(), 'flagged', 5, 25$$), '23514', 'co_remaining_lt_issued', 'CHECK co_remaining_lt_issued: remaining == issued rejected');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, issued_plant_count, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'unfinished', 3, 10, 10, 10, 50, 4, now(), 'flagged', 5, 25$$), '23514', 'co_plants_nonincreasing', 'CHECK co_plants_nonincreasing: more plants left than issued rejected');
  PERFORM pg_temp.expect_ok(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, issued_plant_count, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                           $$'returned', 'unfinished', 3, 10, 10, 10, 50, 3, now(), 'flagged', 5, 25$$), 'CHECK co_plants_nonincreasing is NOT strict: equal plants accepted');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, released_at', $$'released', now()$$), '23514', 'co_released', 'CHECK co_released: release needs a reason');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'unfinished', 10, 10, 10, 50, 1, now(), 'accepted', 5, 25$$), '23514', 'co_accepted', 'CHECK co_accepted: acceptance needs a person and a reason');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'complete', 10, 10, 10, 0, 0, now(), 'ok', 5, 25$$), '23514', 'co_ok_within_threshold', 'CHECK co_ok_within_threshold (raw): ok with 70 g / 233% variance refused');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'variance_g', '5'), '428C9', 'variance_g', 'generated column variance_g cannot be written');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'processed_g', '5'), '428C9', 'processed_g', 'generated column processed_g cannot be written');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status', $$'bogus'$$), '23514', 'trim_checkouts_status_check', 'CHECK status enum');
  PERFORM pg_temp.expect_err(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                            $$'returned', 'weird', 10, 10, 10, 50, 1, now(), 'flagged', 5, 25$$), '23514', 'trim_checkouts_return_kind_check', 'CHECK return_kind enum');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, issued_g, rate_per_lb_applied, checked_out_by) VALUES (%L, 91, %L, 'x', 0, 1, %L)$f$, v_load5, v_staffA, v_ops), '23514', 'trim_checkouts_issued_g_check', 'CHECK issued_g > 0');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, issued_g, rate_per_lb_applied, checked_out_by) VALUES (%L, 91, %L, 'x', 10, 1001, %L)$f$, v_load5, v_staffA, v_ops), '23514', 'trim_checkouts_rate_per_lb_applied_check', 'CHECK rate snapshot <= 1000');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_checkouts (load_id, seq, trimmer_id, trimmer_name, issued_g, rate_per_lb_applied, checked_out_by) VALUES (%L, 0, %L, 'x', 10, 1, %L)$f$, v_load5, v_staffA, v_ops), '23514', 'trim_checkouts_seq_check', 'CHECK seq >= 1');
  -- an absurd weight against a tiny processed_g must come out as a (flagged) variance, never as a numeric overflow
  PERFORM pg_temp.expect_ok(pg_temp.co_sql(v_load5, v_staffA, v_ops, 'status, return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, returned_at, variance_status, flag_pct_applied, flag_floor_g_applied',
                                           $$'returned', 'unfinished', 200000, 0, 0, 99.99, 1, now(), 'flagged', 5, 25$$), 'variance_pct has no overflow at extreme ratios');

  -- ============================ pay-entry tripwires ============================
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount) VALUES (%L, %L, %L, 100, 200, 1.00)$f$, v_co3a, v_batchB, v_staffA), '23514', 'pay_amount_matches', 'CHECK pay_amount_matches (raw insert)');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount, status) VALUES (%L, %L, %L, 0, 0, 0, 'paid')$f$, v_co3a, v_batchB, v_staffA), '23514', 'trim_pay_entries_status_check', 'CHECK pay status: paid-ness lives on the finance bill, not here');
  PERFORM pg_temp.expect_ok(format($f$INSERT INTO public.trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount, status) VALUES (%L, %L, %L, 100, 200, %L, 'approved')$f$, v_co3a, v_batchB, v_staffA, pg_temp.pay(100,200)), 'pay status approved is available for Phase 3');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount) VALUES (%L, %L, %L, 100, 200, %L)$f$, v_ep1, v_batchA, v_staffA, pg_temp.pay(100,200)), '23505', 'trim_pay_entries_checkout_id_key', 'UNIQUE: one pay entry per checkout');
  PERFORM pg_temp.expect_err(format($f$INSERT INTO public.trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount) VALUES (%L, %L, %L, -1, 0, 0)$f$, v_co3a, v_batchB, v_staffA), '23514', 'trim_pay_entries_flower_g_check', 'CHECK flower_g >= 0');

  -- ============================ referential safety ============================
  PERFORM pg_temp.expect_err(format('DELETE FROM public.batches WHERE id = %L', v_batchA), '23001', 'RESTRICT setting', 'FK RESTRICT: a batch with loads cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.room_cycles WHERE id = %L', v_cycle), '23', 'constraint', 'FK RESTRICT: a cycle with batches cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.hanger_loads WHERE id = %L', v_load1), '23001', 'RESTRICT setting', 'FK RESTRICT: a load with checkouts cannot be deleted');
  PERFORM pg_temp.expect_err(format('DELETE FROM public.trim_staff WHERE id = %L', v_staffA), '23001', 'RESTRICT setting', 'FK RESTRICT: a trimmer with checkouts cannot be deleted');

  -- ============================ trim_events is append-only ============================
  PERFORM pg_temp.expect_err($$UPDATE public.trim_events SET payload = '{"tampered":true}'$$, 'P0001', 'append-only', 'events: UPDATE rejected');
  PERFORM pg_temp.expect_err($$UPDATE public.trim_events SET event_type = 'x'$$, 'P0001', 'append-only', 'events: UPDATE of event_type rejected');
  PERFORM pg_temp.expect_err($$UPDATE public.trim_events SET batch_id = NULL WHERE batch_id IS NOT NULL$$, 'P0001', 'append-only', 'events: a hand-rolled UPDATE nulling a reference is rejected too');
  PERFORM pg_temp.expect_err($$DELETE FROM public.trim_events$$, 'P0001', 'append-only', 'events: DELETE rejected');
  PERFORM pg_temp.expect_err($$TRUNCATE public.trim_events$$, 'P0001', 'append-only', 'events: TRUNCATE rejected');
  -- the ONE permitted mutation: the FK ON DELETE SET NULL cascade (deleting a declared, still-empty batch)
  PERFORM public.fn_trim_log_event(v_ops, 'smoke_probe', NULL, NULL, NULL, v_batchC, '{"batch_name":"ZZSMK-C"}'::jsonb);
  DELETE FROM public.batches WHERE id = v_batchC;
  PERFORM pg_temp.ok((SELECT count(*) FROM public.trim_events WHERE event_type = 'smoke_probe' AND batch_id IS NULL AND payload->>'batch_name' = 'ZZSMK-C') = 1, 'events: deleting a declared empty batch succeeds; its event survives with batch_id nulled and the name in the payload');

  -- ============================ final invariants over everything this script created ============================
  PERFORM pg_temp.ok(pg_temp.cache_violations() = 0, 'FINAL cache invariant: every load''s remaining = newest returned episode''s remaining (else dry)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_checkouts GROUP BY load_id HAVING max(seq) <> count(*) OR min(seq) <> 1), 'FINAL gapless seq on every load');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_checkouts WHERE status = 'returned' AND return_kind = 'complete' GROUP BY load_id HAVING count(*) > 1), 'FINAL at most one complete return per load');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.hanger_loads WHERE status NOT IN ('reconciled','void') GROUP BY hanger_id HAVING count(*) > 1), 'FINAL at most one open load per hanger');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.hanger_loads l WHERE status = 'checked_out' AND NOT EXISTS (SELECT 1 FROM public.trim_checkouts c WHERE c.load_id = l.id AND c.status = 'out')), 'FINAL every checked_out load has exactly its out episode');
  PERFORM pg_temp.ok(coalesce((SELECT sum(flower_g) FROM public.trim_pay_entries), 0)
                   = coalesce((SELECT sum(flower_g) FROM public.trim_checkouts WHERE status = 'returned' AND variance_status IN ('ok','accepted')), 0),
                   'FINAL pay-entry flower equals the flower of ok/accepted returned episodes');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.trim_events WHERE actor_user_id IS NULL AND event_type <> 'smoke_probe' AND hanger_id IS NOT NULL), 'FINAL every load event has an actor');
END
$smoke$;

SELECT count(*) AS assertions_passed FROM pg_temp.smoke_log;

ROLLBACK;
