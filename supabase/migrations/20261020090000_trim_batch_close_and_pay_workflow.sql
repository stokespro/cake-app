-- Harvest & Trim, Phase 3: batch close, per-trimmer pay approval that raises a finance bill, reversal, reopen.
-- Plan: .context/harvest-trim-plan.md  (section 2.7, Revision 2: R2.10, R2.14, R2.15). Revision 2 wins where
-- the original text disagrees. Follows 20261014090000_create_harvest_trim_core.sql (Phase 1) to the letter;
-- read its header for the function rules. Restated here because they are the contract:
--   * first lock before any mutable state is read; every state-changing UPDATE carries the expected prior
--     status in its WHERE followed by GET DIAGNOSTICS ... ROW_COUNT and a RAISE when it is not what was expected
--     (the SPRO-131 defence, built into the DB so an action cannot forget it);
--   * errors are RAISE EXCEPTION 'TRIM_E_<CODE>: message' (SQLSTATE P0001). Codes this file adds to Phase 1's set:
--       NO_VENDOR          trimmer has no finance_vendors link (approve)                  -- named by the plan
--       ALREADY_APPROVED   this (batch, trimmer) already has an approved payout (approve)
--       HAS_PAYMENTS       the bill already has a finance_bill_payments row (reverse)
--       RECONCILE          the close-time reconciliation tripwire fired (close)
--     everything else reuses NOT_FOUND / STATE / INVALID;
--   * exactly one trim_events row per successful call, none for a failed one; the actor is always p_actor.
--     New event types: batch_closed, payout_approved, payout_reversed, batch_reopened;
--   * SECURITY DEFINER, search_path pinned, REVOKE ALL FROM PUBLIC, anon, authenticated, GRANT EXECUTE TO service_role.
--
-- LOCK ORDER (all four functions, so they cannot deadlock each other or Phase 1):
--     batch row  (FOR NO KEY UPDATE)  ->  the batch's loads (FOR UPDATE, id order; close only)
--     ->  payout row (reverse)  ->  bill row (reverse)  ->  pay entries.
--   Every function takes the batch lock first, so the later locks are never contended between them.
--   The batch lock is NO KEY UPDATE, not UPDATE, on purpose: Phase 1's check-in inserts a pay entry while
--   holding a load lock, and that insert takes FOR KEY SHARE on the batch row via the FK. FOR UPDATE on the
--   batch here would deadlock against it (close waits on the load, check-in waits on the batch); NO KEY UPDATE
--   does not conflict with KEY SHARE, and it still serialises close / approve / reverse / reopen against each
--   other. Functions that start from a payout id read its (immutable) batch_id first, lock the batch, then lock
--   the payout - the same "read the immutable parent id, lock the parent" move Phase 1 uses for checkouts.
--
-- WHAT A "CLOSE" MEANS (R2.10, R2.14). Trim-complete is NOT sellable. fn_trim_close_batch never touches
-- batches.is_active: the inventory manager flips it in vault admin once the COA is in hand. Closing locks the
-- loads (see the trigger below) and moves the batch's pay entries open -> ready. No money moves, no bill exists.
-- Approval is per trimmer, later, and is the step that creates the bill.
--
-- THE BILL (R2.14). fn_trim_approve_payout INSERTs the finance_bills row itself, inside Postgres, so the trim
-- manager needs only TRIM_PAY_APPROVE_ROLES and never the finance module (createBill stays requireFinance()-gated
-- and is not called). It writes vendor_id, name, period_month, amount, due_date, notes, status 'unpaid',
-- amount_paid 0, created_by and NOTHING ELSE: amount_paid / status / paid_date / payment_method / payment_ref
-- are trigger-derived from finance_bill_payments (SPRO-82) and are never set here after the insert.
--
-- KNOWN GAPS, stated plainly:
--   * trim_pay_entries has no CHECK "status = 'approved' => payout_id IS NOT NULL". The Phase 1 smoke script
--     deliberately inserts an 'approved' entry with no payout to prove the status enum, and a stricter CHECK
--     would break that already-shipped test. Only the safe direction is enforced (payout_id set => approved);
--     the other direction is asserted by supabase/tests/trim_pay_smoke.sql instead.
--   * Finance can un-void a bill (setBillVoid(id, false)). If someone un-voids a bill this module voided on
--     reversal, a live bill exists for a payout marked 'reversed' and re-approval would bill the work twice.
--     Fixing it means changing the finance module, which this phase must not do; flagged for review.
--   * fn_trim_reopen_batch does not check the caller's role (like Phase 1's fn_trim_reopen); "admin only" is
--     enforced by the action's role gate.
--
-- Do NOT apply manually. Joshua applies via Supabase MCP after the PR merges, and only AFTER
-- 20261014090000 (Phase 1) - the preflight below fails loudly otherwise.

BEGIN;

-- ============================================================
-- 0. PREFLIGHT: fail loudly, before creating anything
-- ============================================================
DO $$
DECLARE c text;
BEGIN
  IF to_regclass('public.trim_pay_entries') IS NULL OR to_regclass('public.trim_staff') IS NULL
     OR to_regclass('public.hanger_loads') IS NULL OR to_regclass('public.trim_checkouts') IS NULL
     OR to_regprocedure('public.fn_trim_log_event(uuid,text,uuid,uuid,uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'preflight: Phase 1 objects missing - apply 20261014090000_create_harvest_trim_core.sql first';
  END IF;
  IF to_regclass('public.finance_bills') IS NULL OR to_regclass('public.finance_vendors') IS NULL
     OR to_regclass('public.finance_bill_payments') IS NULL THEN
    RAISE EXCEPTION 'preflight: finance_bills / finance_vendors / finance_bill_payments not found';
  END IF;
  FOREACH c IN ARRAY ARRAY['vendor_id','name','period_month','amount','due_date','notes','status','amount_paid','created_by','updated_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'finance_bills' AND column_name = c) THEN
      RAISE EXCEPTION 'preflight: finance_bills.% not found - the bill insert in fn_trim_approve_payout would fail', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'finance_vendors' AND column_name = 'is_active') THEN
    RAISE EXCEPTION 'preflight: finance_vendors.is_active not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.finance_bills'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%''void''%') THEN
    RAISE EXCEPTION 'preflight: finance_bills status CHECK does not allow ''void'' - reversal needs it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trim_staff' AND column_name = 'vendor_id') THEN
    RAISE EXCEPTION 'preflight: trim_staff.vendor_id missing (Phase 1)';
  END IF;
END $$;

-- ============================================================
-- 1. DDL
-- ============================================================

-- ---- batches: the close stamp ------------------------------------------------------------------
-- Nullable; NULL = trim not closed. Derivation of the batch lifecycle stays column-free (R2.10): there is
-- deliberately no batches.status. The "needs testing" queue is: trim_closed_at IS NOT NULL, no THC / COA,
-- is_active = false.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS trim_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trim_closed_by uuid REFERENCES public.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batches_trim_closed
  ON public.batches (trim_closed_at) WHERE trim_closed_at IS NOT NULL;
COMMENT ON COLUMN public.batches.trim_closed_at IS
  'Set by fn_trim_close_batch when every load on the batch is reconciled or void. Trim-complete is NOT sellable: '
  'this never touches is_active (the inventory manager flips that in vault admin once the COA is in hand).';

-- ---- trim_payouts: one row per (batch, trimmer) approval (R2.14) --------------------------------
CREATE TABLE IF NOT EXISTS public.trim_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES public.batches(id)         ON DELETE RESTRICT,
  trimmer_id      uuid NOT NULL REFERENCES public.trim_staff(id)      ON DELETE RESTRICT,
  vendor_id       uuid NOT NULL REFERENCES public.finance_vendors(id) ON DELETE RESTRICT,
  flower_g        numeric(10,2) NOT NULL CHECK (flower_g >= 0),       -- snapshotted at approval
  amount          numeric(10,2) NOT NULL CHECK (amount > 0),
  due_date        date NOT NULL,                                      -- captured at approval (Joshua's requirement)
  -- NOT NULL (the plan sketch leaves it nullable): the bill is inserted before the payout in the same
  -- transaction, so a payout without its bill is unrepresentable. Kept after reversal (the bill is voided,
  -- not deleted, so the number stays auditable). UNIQUE: a bill can belong to one payout only.
  bill_id         uuid NOT NULL UNIQUE REFERENCES public.finance_bills(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','reversed')),
  approved_by     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at     timestamptz NOT NULL DEFAULT now(),
  reversed_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reversed_at     timestamptz,
  reverse_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_approved_clean CHECK (status <> 'approved' OR
    (reversed_at IS NULL AND reversed_by IS NULL AND reverse_reason IS NULL)),
  CONSTRAINT payout_reversed_complete CHECK (status <> 'reversed' OR
    (reversed_at IS NOT NULL AND length(btrim(coalesce(reverse_reason, ''))) >= 3))
);
-- INVARIANT: a (batch, trimmer) pair can hold at most ONE approved payout, so it cannot be double-billed.
-- Partial: a reversed payout does not block a fresh approval of the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_trim_payouts_one_approved_per_pair
  ON public.trim_payouts (batch_id, trimmer_id) WHERE status = 'approved';
-- batch page / review screen
CREATE INDEX IF NOT EXISTS idx_trim_payouts_batch   ON public.trim_payouts (batch_id, status);
-- pay register by trimmer, newest first; also the "previous approved payout" lookup for the rate-change note
CREATE INDEX IF NOT EXISTS idx_trim_payouts_trimmer ON public.trim_payouts (trimmer_id, approved_at DESC);
-- FK RESTRICT checks when a vendor is deleted
CREATE INDEX IF NOT EXISTS idx_trim_payouts_vendor  ON public.trim_payouts (vendor_id);
COMMENT ON TABLE public.trim_payouts IS
  'One row per (batch, trimmer) pay approval (R2.14). Created ONLY by fn_trim_approve_payout, in the same '
  'transaction as its finance_bills row. Payment status is NOT stored here: read it from the bill, whose '
  'amount_paid / status are derived from finance_bill_payments. A reversed payout keeps its (voided) bill_id.';

DROP TRIGGER IF EXISTS trg_trim_payouts_updated_at ON public.trim_payouts;
CREATE TRIGGER trg_trim_payouts_updated_at BEFORE UPDATE ON public.trim_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.trim_payouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trim_payouts FROM anon, authenticated;

-- ---- trim_pay_entries.payout_id -------------------------------------------------------------------
-- The status set (open | ready | approved) is Phase 1's and is NOT changed here.
ALTER TABLE public.trim_pay_entries
  ADD COLUMN IF NOT EXISTS payout_id uuid REFERENCES public.trim_payouts(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_trim_pay_payout ON public.trim_pay_entries (payout_id) WHERE payout_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.trim_pay_entries'::regclass AND conname = 'pay_payout_only_when_approved') THEN
    -- safe direction only; see KNOWN GAPS in the header
    ALTER TABLE public.trim_pay_entries ADD CONSTRAINT pay_payout_only_when_approved
      CHECK (payout_id IS NULL OR status = 'approved');
  END IF;
END $$;

-- ---- a closed batch accepts no new loads -------------------------------------------------------------
-- "Close the batch - locks every hanger." Phase 1's functions know nothing about trim_closed_at, so without
-- this a late fn_trim_create_load could add a 'hung' load (and later an 'open' pay entry) to a batch that is
-- already closed - the batch would then hold unfinished work that the close gate never saw, and that
-- trimmer's pay could never reach 'ready'. Reopen the batch (only possible while no payout is approved) to
-- add a forgotten hanger. FOR SHARE (not KEY SHARE) so it conflicts with fn_trim_close_batch's NO KEY UPDATE
-- lock: a load inserted concurrently with a close either commits first (and the close sees it as a blocker)
-- or waits for the close and is then refused.
CREATE OR REPLACE FUNCTION public.fn_trim_loads_block_closed_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_closed timestamptz;
  v_name   text;
BEGIN
  SELECT trim_closed_at, name INTO v_closed, v_name FROM batches WHERE id = NEW.batch_id FOR SHARE;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % was trim-closed on % - reopen it before adding loads',
      v_name, to_char(v_closed AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_hanger_loads_block_closed_batch ON public.hanger_loads;
CREATE TRIGGER trg_hanger_loads_block_closed_batch BEFORE INSERT ON public.hanger_loads
  FOR EACH ROW EXECUTE FUNCTION public.fn_trim_loads_block_closed_batch();

COMMENT ON TABLE public.trim_events IS
  'Append-only audit log. event_type values written by the fn_trim_* functions: hangers_created, '
  'batches_declared, load_created, dry_recorded, dry_corrected, wet_corrected, checked_out, released, '
  'checked_in, return_corrected, variance_resolved, reopened, voided (Phase 1); batch_closed, '
  'payout_approved, payout_reversed, batch_reopened (Phase 3). Actions add their own for '
  'direct writes (e.g. trim_staff_rate_changed). UPDATE / DELETE / TRUNCATE are rejected by trigger.';

-- ============================================================
-- 2. INTERNAL HELPER
-- ============================================================
-- "$225.00" or "$225.00-$250.00" (mixed rates inside one payout). Pure; used only for bill notes / errors.
CREATE OR REPLACE FUNCTION public.fn_trim_fmt_rate(p_min numeric, p_max numeric) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
           WHEN p_min IS NULL OR p_max IS NULL THEN 'n/a'
           WHEN p_min = p_max THEN '$' || to_char(p_min, 'FM999990.00')
           ELSE '$' || to_char(p_min, 'FM999990.00') || '-$' || to_char(p_max, 'FM999990.00')
         END
$$;

-- ============================================================
-- 3. FUNCTIONS
-- ============================================================

-- ---- fn_trim_close_batch ------------------------------------------------------------------------
-- Raises TRIM_E_STATE unless EVERY load on the batch is reconciled or void and at least one is reconciled;
-- the error names the blocking hangers (up to 12) and their state ('flagged' = a return awaiting variance
-- resolution). Then, in this order: optional rack-count speed bump, entry-state check, reconciliation
-- tripwire, stamp batches.trim_closed_at/by, flip this batch's trim_pay_entries open -> ready. NEVER touches
-- is_active.
--
-- p_confirmed_hanger_count is OPTIONAL (an addition to the plan's (p_batch_id, p_actor) signature, which
-- still works as written). The plan's closeTrimBatch takes a client-supplied confirmedHangerCount and
-- compares it to the server's count of hangers carrying a reconciled load; doing that here, under the lock,
-- avoids a read-then-call race in the action. NULL skips the check.
--
-- RECONCILIATION TRIPWIRE (TRIM_E_RECONCILE) - the check that catches pay drifting from production:
--   sum(trim_pay_entries.flower_g) over the batch  must equal  sum(trim_checkouts.flower_g) over the batch's
--   RETURNED episodes. Both sides count THE SAME LOADS: every load of the batch INCLUDING void ones. That is
--   not an accident (Phase 1 caveat above fn_trim_void): voiding a `partial` load leaves its earlier
--   episodes' pay entries in place (the trimmers did that work and are owed for it), so excluding void loads
--   from the episode side - or from the entry side - would make a legitimately voided partial fail the close.
--   Equal totals can hide offsetting errors, so the same gate also requires a one-to-one match: every returned
--   episode has exactly one pay entry with the same flower_g, and every pay entry of the batch belongs to a
--   returned episode of the batch. Why this population is exactly right at close time: a flagged return
--   (no pay entry yet) leaves its load in 'returned', which is a blocker, and `partial` can only be left by
--   resolving (entry created) or voiding (episodes already resolved), so every returned episode of a
--   reconciled-or-void load has an entry.
-- Returns {batch_id, batch_name, trim_closed_at, reconciled_loads, void_loads, hangers, ready_entries,
--          total_flower_g, total_amount, trimmers: [{trimmer_id, trimmer_name, entries, flower_g, amount}]}.
CREATE OR REPLACE FUNCTION public.fn_trim_close_batch(
  p_batch_id uuid, p_actor uuid, p_confirmed_hanger_count integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch      public.batches;
  v_new        public.batches;
  v_unfinished integer;
  v_list       text;
  v_reconciled integer;
  v_void       integer;
  v_hangers    integer;
  v_entries    integer;
  v_nonopen    integer;
  v_pay_g      numeric;
  v_ep_g       numeric;
  v_bad        integer;
  v_total_g    numeric;
  v_total_amt  numeric;
  v_trimmers   jsonb;
  v_n          integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;

  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: batch %', p_batch_id; END IF;
  IF v_batch.trim_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % is already trim-closed', v_batch.name;
  END IF;

  -- freeze the batch: every load (id order) and every pay entry, so nothing can change under the checks
  PERFORM 1 FROM hanger_loads WHERE batch_id = p_batch_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM trim_pay_entries WHERE batch_id = p_batch_id ORDER BY id FOR UPDATE;

  SELECT count(*) FILTER (WHERE status NOT IN ('reconciled','void')),
         count(*) FILTER (WHERE status = 'reconciled'),
         count(*) FILTER (WHERE status = 'void'),
         count(DISTINCT hanger_id) FILTER (WHERE status = 'reconciled')
    INTO v_unfinished, v_reconciled, v_void, v_hangers
    FROM hanger_loads WHERE batch_id = p_batch_id;

  IF v_unfinished > 0 THEN
    SELECT string_agg(code || ' (' || st || ')', ', ' ORDER BY code) INTO v_list
      FROM (SELECT h.code, CASE l.status WHEN 'returned' THEN 'flagged' ELSE l.status END AS st
              FROM hanger_loads l JOIN hangers h ON h.id = l.hanger_id
             WHERE l.batch_id = p_batch_id AND l.status NOT IN ('reconciled','void')
             ORDER BY h.code LIMIT 12) q;
    IF v_unfinished > 12 THEN v_list := v_list || format(' (+%s more)', v_unfinished - 12); END IF;
    RAISE EXCEPTION 'TRIM_E_STATE: % load(s) are not finished and block closing batch %: %',
      v_unfinished, v_batch.name, v_list;
  END IF;
  IF v_reconciled = 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % has no reconciled load - nothing to close (% void)', v_batch.name, v_void;
  END IF;
  IF p_confirmed_hanger_count IS NOT NULL AND p_confirmed_hanger_count <> v_hangers THEN
    RAISE EXCEPTION 'TRIM_E_STATE: rack count mismatch - you confirmed % hanger(s) but % carry a reconciled load in batch %',
      p_confirmed_hanger_count, v_hangers, v_batch.name;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status <> 'open') INTO v_entries, v_nonopen
    FROM trim_pay_entries WHERE batch_id = p_batch_id;
  IF v_nonopen > 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % is not closed but % of its pay entries are already ready / approved - investigate before closing',
      v_batch.name, v_nonopen;
  END IF;

  -- ---- reconciliation tripwire (see header) ----
  SELECT coalesce(sum(flower_g), 0) INTO v_pay_g FROM trim_pay_entries WHERE batch_id = p_batch_id;
  SELECT coalesce(sum(c.flower_g), 0) INTO v_ep_g
    FROM trim_checkouts c JOIN hanger_loads l ON l.id = c.load_id
   WHERE l.batch_id = p_batch_id AND c.status = 'returned';
  IF v_pay_g <> v_ep_g THEN
    RAISE EXCEPTION 'TRIM_E_RECONCILE: batch % pay entries total % g flower but its returned episodes total % g - pay has drifted from production; do not close',
      v_batch.name, v_pay_g, v_ep_g;
  END IF;
  SELECT count(*) INTO v_bad
    FROM (SELECT c.id AS co_id, c.flower_g
            FROM trim_checkouts c JOIN hanger_loads l ON l.id = c.load_id
           WHERE l.batch_id = p_batch_id AND c.status = 'returned') e
    FULL JOIN (SELECT checkout_id, flower_g FROM trim_pay_entries WHERE batch_id = p_batch_id) p
      ON p.checkout_id = e.co_id
   WHERE e.co_id IS NULL OR p.checkout_id IS NULL OR e.flower_g IS DISTINCT FROM p.flower_g;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'TRIM_E_RECONCILE: batch % has % pay entr(ies)/episode(s) that do not match one-to-one (totals agree, rows do not) - do not close',
      v_batch.name, v_bad;
  END IF;

  UPDATE batches SET trim_closed_at = now(), trim_closed_by = p_actor
   WHERE id = p_batch_id AND trim_closed_at IS NULL
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: batch % changed state while closing', v_batch.name; END IF;

  UPDATE trim_pay_entries SET status = 'ready', updated_at = now()
   WHERE batch_id = p_batch_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_entries THEN
    RAISE EXCEPTION 'TRIM_E_STATE: expected to ready % pay entries for batch % but moved %', v_entries, v_batch.name, v_n;
  END IF;

  SELECT coalesce(sum(flower_g), 0), coalesce(sum(amount), 0) INTO v_total_g, v_total_amt
    FROM trim_pay_entries WHERE batch_id = p_batch_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('trimmer_id', trimmer_id, 'trimmer_name', nm, 'entries', n,
                                               'flower_g', fg, 'amount', amt) ORDER BY nm), '[]'::jsonb)
    INTO v_trimmers
    FROM (SELECT e.trimmer_id, s.full_name AS nm, count(*) AS n, sum(e.flower_g) AS fg, sum(e.amount) AS amt
            FROM trim_pay_entries e JOIN trim_staff s ON s.id = e.trimmer_id
           WHERE e.batch_id = p_batch_id GROUP BY e.trimmer_id, s.full_name) q;

  PERFORM fn_trim_log_event(p_actor, 'batch_closed', NULL, NULL, NULL, p_batch_id,
    jsonb_build_object('batch_name', v_batch.name, 'reconciled_loads', v_reconciled, 'void_loads', v_void,
                       'hangers', v_hangers, 'ready_entries', v_entries,
                       'total_flower_g', v_total_g, 'total_amount', v_total_amt,
                       'confirmed_hanger_count', p_confirmed_hanger_count, 'trimmers', v_trimmers));
  RETURN jsonb_build_object('batch_id', p_batch_id, 'batch_name', v_batch.name,
                            'trim_closed_at', v_new.trim_closed_at,
                            'reconciled_loads', v_reconciled, 'void_loads', v_void, 'hangers', v_hangers,
                            'ready_entries', v_entries, 'total_flower_g', v_total_g, 'total_amount', v_total_amt,
                            'trimmers', v_trimmers);
END $$;

-- ---- fn_trim_approve_payout ---------------------------------------------------------------------
-- ONE transaction: bill + payout + entries + event, or nothing. Guards, in order: actor / due date supplied;
-- batch exists and is trim-closed; trimmer exists, has a vendor (TRIM_E_NO_VENDOR) and that vendor is active;
-- no approved payout for the pair (TRIM_E_ALREADY_APPROVED); due date sane (not before the trim-close DATE in
-- America/Chicago, not more than 365 days after today there); the trimmer's entries on the batch are all
-- 'ready' and there is at least one; the total is > 0.
-- The bill is written exactly as the header says. period_month = date_trunc('month', p_due_date)::date, the
-- same value as derivePeriodMonth() in actions/finance.ts (first 7 chars of the due date + '-01').
-- bill.notes = hangers / episodes / flower lbs / rate / amount / approver, plus (R2.15) a line
-- "Rate changed $225.00 -> $250.00/lb since last batch (<batch>)" whenever this payout's rate (or rate range)
-- differs from the trimmer's most recently approved payout; the same facts go into the event payload.
-- Returns {payout: <trim_payouts row>, bill: <finance_bills row>, entry_count, hangers, flower_g, amount,
--          rate_min, rate_max, rate_changed, previous_rate_min, previous_rate_max}.
CREATE OR REPLACE FUNCTION public.fn_trim_approve_payout(
  p_batch_id uuid, p_trimmer_id uuid, p_due_date date, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch      public.batches;
  v_staff      public.trim_staff;
  v_vendor     public.finance_vendors;
  v_actor_name text;
  v_close_date date;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_ready      integer;
  v_other      integer;
  v_flower_g   numeric;
  v_amount     numeric;
  v_hangers    integer;
  v_rate_min   numeric;
  v_rate_max   numeric;
  v_prev_id    uuid;
  v_prev_batch text;
  v_prev_min   numeric;
  v_prev_max   numeric;
  v_changed    boolean := false;
  v_payout_id  uuid := gen_random_uuid();
  v_notes      text;
  v_bill       public.finance_bills;
  v_payout     public.trim_payouts;
  v_n          integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF p_due_date IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: a due date is required to approve a payout'; END IF;
  SELECT name INTO v_actor_name FROM users WHERE id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor % is not a user', p_actor; END IF;

  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: batch %', p_batch_id; END IF;
  IF v_batch.trim_closed_at IS NULL THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % is not trim-closed - close it before approving pay', v_batch.name;
  END IF;

  SELECT * INTO v_staff FROM trim_staff WHERE id = p_trimmer_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: trimmer %', p_trimmer_id; END IF;
  IF v_staff.vendor_id IS NULL THEN
    RAISE EXCEPTION 'TRIM_E_NO_VENDOR: % has no finance vendor linked - link or create a vendor on the trim staff record, then approve', v_staff.full_name;
  END IF;
  SELECT * INTO v_vendor FROM finance_vendors WHERE id = v_staff.vendor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: vendor % for trimmer %', v_staff.vendor_id, v_staff.full_name; END IF;
  IF NOT v_vendor.is_active THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: vendor % (linked to %) is inactive - reactivate it or link another vendor', v_vendor.name, v_staff.full_name;
  END IF;

  IF EXISTS (SELECT 1 FROM trim_payouts WHERE batch_id = p_batch_id AND trimmer_id = p_trimmer_id AND status = 'approved') THEN
    RAISE EXCEPTION 'TRIM_E_ALREADY_APPROVED: % already has an approved payout for batch % - reverse it first to change it',
      v_staff.full_name, v_batch.name;
  END IF;

  v_close_date := (v_batch.trim_closed_at AT TIME ZONE 'America/Chicago')::date;
  IF p_due_date < v_close_date THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: due date % is before the batch was trim-closed (%)', p_due_date, v_close_date;
  END IF;
  IF p_due_date > v_today + 365 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: due date % is more than a year out', p_due_date;
  END IF;

  PERFORM 1 FROM trim_pay_entries WHERE batch_id = p_batch_id AND trimmer_id = p_trimmer_id ORDER BY id FOR UPDATE;
  SELECT count(*) FILTER (WHERE status = 'ready'), count(*) FILTER (WHERE status <> 'ready')
    INTO v_ready, v_other
    FROM trim_pay_entries WHERE batch_id = p_batch_id AND trimmer_id = p_trimmer_id;
  IF v_other > 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: % of % pay entries on batch % are not ready (open or already approved)', v_other, v_staff.full_name, v_batch.name;
  END IF;
  IF v_ready = 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: % has no ready pay entries on batch %', v_staff.full_name, v_batch.name;
  END IF;

  SELECT sum(e.flower_g), sum(e.amount), min(e.rate_per_lb_applied), max(e.rate_per_lb_applied),
         count(DISTINCT l.hanger_id)
    INTO v_flower_g, v_amount, v_rate_min, v_rate_max, v_hangers
    FROM trim_pay_entries e
    JOIN trim_checkouts c ON c.id = e.checkout_id
    JOIN hanger_loads l   ON l.id = c.load_id
   WHERE e.batch_id = p_batch_id AND e.trimmer_id = p_trimmer_id AND e.status = 'ready';
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: nothing is owed to % on batch % (total %)', v_staff.full_name, v_batch.name, coalesce(v_amount, 0);
  END IF;

  -- R2.15: surface a rate change where finance looks. "Previous" = this trimmer's latest still-approved payout
  -- (approved_at is stamped with clock_timestamp(), not now(), so two approvals inside one transaction still order).
  SELECT p.id, b.name, min(e.rate_per_lb_applied), max(e.rate_per_lb_applied)
    INTO v_prev_id, v_prev_batch, v_prev_min, v_prev_max
    FROM trim_payouts p
    JOIN batches b ON b.id = p.batch_id
    JOIN trim_pay_entries e ON e.payout_id = p.id
   WHERE p.trimmer_id = p_trimmer_id AND p.status = 'approved'
   GROUP BY p.id, b.name, p.approved_at
   ORDER BY p.approved_at DESC, p.id DESC
   LIMIT 1;
  IF v_prev_id IS NOT NULL AND (v_prev_min IS DISTINCT FROM v_rate_min OR v_prev_max IS DISTINCT FROM v_rate_max) THEN
    v_changed := true;
  END IF;

  v_notes := 'Trim payout - batch ' || v_batch.name || ' - ' || v_staff.full_name
    || E'\nHangers: ' || v_hangers || ' (' || v_ready || CASE WHEN v_ready = 1 THEN ' episode)' ELSE ' episodes)' END
    || E'\nFlower: ' || to_char(round(v_flower_g / 453.59237, 2), 'FM999,990.00') || ' lb (' || to_char(v_flower_g, 'FM999,999,990.00') || ' g)'
    || E'\nRate: ' || fn_trim_fmt_rate(v_rate_min, v_rate_max) || '/lb'
    || E'\nAmount: $' || to_char(v_amount, 'FM999,999,990.00')
    || CASE WHEN v_changed
         THEN E'\nRATE CHANGED ' || fn_trim_fmt_rate(v_prev_min, v_prev_max) || ' -> ' || fn_trim_fmt_rate(v_rate_min, v_rate_max)
              || '/lb since last batch (' || v_prev_batch || ')'
         ELSE '' END
    || E'\nApproved by ' || coalesce(v_actor_name, 'unknown') || ' (trim payout ' || v_payout_id || ')';

  -- The bill. Exactly these columns; the payment columns are trigger-derived (SPRO-82) and never written.
  INSERT INTO finance_bills (vendor_id, name, period_month, amount, due_date, notes, status, amount_paid, created_by)
  VALUES (v_staff.vendor_id, 'Trim - ' || v_batch.name || ' - ' || v_staff.full_name,
          date_trunc('month', p_due_date)::date, v_amount, p_due_date, v_notes, 'unpaid', 0, p_actor)
  RETURNING * INTO v_bill;

  INSERT INTO trim_payouts (id, batch_id, trimmer_id, vendor_id, flower_g, amount, due_date, bill_id,
                            status, approved_by, approved_at)
  VALUES (v_payout_id, p_batch_id, p_trimmer_id, v_staff.vendor_id, v_flower_g, v_amount, p_due_date, v_bill.id,
          'approved', p_actor, clock_timestamp())
  RETURNING * INTO v_payout;

  UPDATE trim_pay_entries SET payout_id = v_payout.id, status = 'approved', updated_at = now()
   WHERE batch_id = p_batch_id AND trimmer_id = p_trimmer_id AND status = 'ready';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_ready THEN
    RAISE EXCEPTION 'TRIM_E_STATE: expected to approve % pay entries for % but moved %', v_ready, v_staff.full_name, v_n;
  END IF;

  PERFORM fn_trim_log_event(p_actor, 'payout_approved', NULL, NULL, NULL, p_batch_id,
    jsonb_build_object('payout_id', v_payout.id, 'bill_id', v_bill.id, 'batch_name', v_batch.name,
      'trimmer_id', p_trimmer_id, 'trimmer_name', v_staff.full_name,
      'vendor_id', v_staff.vendor_id, 'vendor_name', v_vendor.name,
      'flower_g', v_flower_g, 'amount', v_amount, 'due_date', p_due_date,
      'period_month', v_bill.period_month, 'entries', v_ready, 'hangers', v_hangers,
      'rate_min', v_rate_min, 'rate_max', v_rate_max,
      'rate_changed', v_changed, 'previous_rate_min', v_prev_min, 'previous_rate_max', v_prev_max,
      'previous_batch', v_prev_batch));
  RETURN jsonb_build_object('payout', to_jsonb(v_payout), 'bill', to_jsonb(v_bill),
                            'entry_count', v_ready, 'hangers', v_hangers, 'flower_g', v_flower_g, 'amount', v_amount,
                            'rate_min', v_rate_min, 'rate_max', v_rate_max, 'rate_changed', v_changed,
                            'previous_rate_min', v_prev_min, 'previous_rate_max', v_prev_max);
END $$;

-- ---- fn_trim_reverse_payout ---------------------------------------------------------------------
-- Refuses (TRIM_E_HAS_PAYMENTS) if the bill has ANY finance_bill_payments row - once money has moved the
-- correction belongs in finance, not here. Otherwise: bill status -> 'void' (never deleted; the bill number
-- stays auditable; a note with the reason is appended to bill.notes), payout -> 'reversed', entries ->
-- 'ready' with payout_id cleared. A bill finance already voided by hand (no payments) is accepted, so a
-- payout can never be stuck behind a bill nobody can pay. The bill row is locked FOR UPDATE before the
-- payments check, which conflicts with the FOR KEY SHARE a concurrent payment insert takes on its bill:
-- the payment either commits first (and is seen) or waits for this transaction (and is then refused, the
-- bill being void).
-- Returns {payout: <row>, bill: <row>, entries_returned}.
CREATE OR REPLACE FUNCTION public.fn_trim_reverse_payout(
  p_payout_id uuid, p_reason text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch_id  uuid;
  v_batch     public.batches;
  v_payout    public.trim_payouts;
  v_bill      public.finance_bills;
  v_staff_nm  text;
  v_pay_n     integer;
  v_pay_sum   numeric;
  v_entries   integer;
  v_n         integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a reversal reason of at least 3 characters is required';
  END IF;

  SELECT batch_id INTO v_batch_id FROM trim_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: payout %', p_payout_id; END IF;
  SELECT * INTO v_batch FROM batches WHERE id = v_batch_id FOR NO KEY UPDATE;
  SELECT * INTO v_payout FROM trim_payouts WHERE id = p_payout_id FOR UPDATE;
  IF v_payout.status <> 'approved' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: payout is %, only an approved payout can be reversed', v_payout.status;
  END IF;
  SELECT full_name INTO v_staff_nm FROM trim_staff WHERE id = v_payout.trimmer_id;

  SELECT * INTO v_bill FROM finance_bills WHERE id = v_payout.bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_STATE: bill % for this payout no longer exists', v_payout.bill_id; END IF;
  SELECT count(*), coalesce(sum(amount), 0) INTO v_pay_n, v_pay_sum FROM finance_bill_payments WHERE bill_id = v_bill.id;
  IF v_pay_n > 0 THEN
    RAISE EXCEPTION 'TRIM_E_HAS_PAYMENTS: the bill already has % payment(s) totalling $% - it cannot be reversed here; correct it in finance',
      v_pay_n, v_pay_sum;
  END IF;

  PERFORM 1 FROM trim_pay_entries WHERE payout_id = v_payout.id ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_entries FROM trim_pay_entries WHERE payout_id = v_payout.id AND status = 'approved';
  IF v_entries = 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: payout % has no approved pay entries to return', v_payout.id;
  END IF;

  -- status IN ('unpaid','void'): with no payments a bill can only be one of the two; anything else is drift
  UPDATE finance_bills
     SET status = 'void',
         notes = concat_ws(E'\n', notes, 'VOIDED by trim payout reversal: ' || btrim(p_reason)),
         updated_at = now()
   WHERE id = v_bill.id AND status IN ('unpaid','void')
  RETURNING * INTO v_bill;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: bill status is not unpaid/void although it has no payments - refusing to reverse; investigate';
  END IF;

  UPDATE trim_payouts
     SET status = 'reversed', reversed_by = p_actor, reversed_at = now(), reverse_reason = btrim(p_reason),
         updated_at = now()
   WHERE id = v_payout.id AND status = 'approved'
  RETURNING * INTO v_payout;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: payout is no longer approved'; END IF;

  UPDATE trim_pay_entries SET status = 'ready', payout_id = NULL, updated_at = now()
   WHERE payout_id = v_payout.id AND status = 'approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_entries THEN
    RAISE EXCEPTION 'TRIM_E_STATE: expected to return % pay entries to ready but moved %', v_entries, v_n;
  END IF;

  PERFORM fn_trim_log_event(p_actor, 'payout_reversed', NULL, NULL, NULL, v_batch_id,
    jsonb_build_object('payout_id', v_payout.id, 'bill_id', v_bill.id, 'batch_name', v_batch.name,
      'trimmer_id', v_payout.trimmer_id, 'trimmer_name', v_staff_nm, 'amount', v_payout.amount,
      'flower_g', v_payout.flower_g, 'entries_returned', v_entries, 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('payout', to_jsonb(v_payout), 'bill', to_jsonb(v_bill), 'entries_returned', v_entries);
END $$;

-- ---- fn_trim_reopen_batch -----------------------------------------------------------------------
-- Admin path (the role gate is the action's). Refuses while ANY payout of the batch is 'approved' (reverse
-- those first). Clears trim_closed_at/by and returns the batch's pay entries ready -> open. Does not touch
-- is_active and does not touch loads (a reconciled load is reopened separately with fn_trim_reopen, which
-- needs its entry 'open' - i.e. this call first). Reason is mandatory (>= 3 chars).
-- Returns {batch_id, batch_name, entries_reopened, previously_closed_at}.
CREATE OR REPLACE FUNCTION public.fn_trim_reopen_batch(
  p_batch_id uuid, p_reason text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch    public.batches;
  v_approved integer;
  v_entries  integer;
  v_nonready integer;
  v_n        integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a reopen reason of at least 3 characters is required';
  END IF;

  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: batch %', p_batch_id; END IF;
  IF v_batch.trim_closed_at IS NULL THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % is not trim-closed', v_batch.name;
  END IF;

  SELECT count(*) INTO v_approved FROM trim_payouts WHERE batch_id = p_batch_id AND status = 'approved';
  IF v_approved > 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % has % approved payout(s) - reverse them before reopening', v_batch.name, v_approved;
  END IF;

  PERFORM 1 FROM trim_pay_entries WHERE batch_id = p_batch_id ORDER BY id FOR UPDATE;
  SELECT count(*), count(*) FILTER (WHERE status <> 'ready') INTO v_entries, v_nonready
    FROM trim_pay_entries WHERE batch_id = p_batch_id;
  IF v_nonready > 0 THEN
    RAISE EXCEPTION 'TRIM_E_STATE: batch % has % pay entr(ies) that are not ready - cannot reopen; investigate', v_batch.name, v_nonready;
  END IF;

  UPDATE batches SET trim_closed_at = NULL, trim_closed_by = NULL
   WHERE id = p_batch_id AND trim_closed_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: batch % changed state while reopening', v_batch.name; END IF;

  UPDATE trim_pay_entries SET status = 'open', updated_at = now()
   WHERE batch_id = p_batch_id AND status = 'ready';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_entries THEN
    RAISE EXCEPTION 'TRIM_E_STATE: expected to reopen % pay entries for batch % but moved %', v_entries, v_batch.name, v_n;
  END IF;

  PERFORM fn_trim_log_event(p_actor, 'batch_reopened', NULL, NULL, NULL, p_batch_id,
    jsonb_build_object('batch_name', v_batch.name, 'reason', btrim(p_reason), 'entries_reopened', v_entries,
                       'previously_closed_at', v_batch.trim_closed_at, 'previously_closed_by', v_batch.trim_closed_by));
  RETURN jsonb_build_object('batch_id', p_batch_id, 'batch_name', v_batch.name,
                            'entries_reopened', v_entries, 'previously_closed_at', v_batch.trim_closed_at);
END $$;

-- ============================================================
-- 4. PRIVILEGES: service_role only
-- ============================================================
REVOKE ALL ON FUNCTION public.fn_trim_loads_block_closed_batch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_trim_fmt_rate(numeric,numeric) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_trim_close_batch(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_close_batch(uuid,uuid,integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_approve_payout(uuid,uuid,date,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_approve_payout(uuid,uuid,date,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_reverse_payout(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_reverse_payout(uuid,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_reopen_batch(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_reopen_batch(uuid,text,uuid) TO service_role;

COMMIT;
