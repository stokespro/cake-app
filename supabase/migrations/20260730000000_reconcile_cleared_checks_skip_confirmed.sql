-- SPRO-43 GAP-A (P0, money) — cron path still double-pays.
--
-- reconcile_cleared_checks() only skipped a transaction that already had an
-- 'auto_applied' row. A transaction manually 'confirmed' (via
-- confirmReconciliationMatch or assign_reconciliation_match) was NOT
-- skipped, so the next cron run re-scanned it, found a bill by check
-- number, and paid THAT bill too — a second payment from the same debit.
--
-- Reproduced end-to-end on a branch running production's real function
-- body: user manually assigns txn 5000 ($500) -> Bill X (correctly
-- succeeds — nothing spent yet at that point); cron then runs
-- reconcile_cleared_checks() and pays Bill W as well, from the same $500
-- debit. sum(amount_paid) = 1000.00 off one $500 transaction. The
-- assign_reconciliation_match() RPC's bank_txn_spent guard (added in
-- 20260728130000_assign_reconciliation_match_rpc.sql) only covers the
-- manual-assign path — this cron path is separate code with its own copy
-- of the same check.
--
-- Order matters: cron-first-then-manual was already correctly blocked
-- (assign_reconciliation_match's bank_txn_spent guard already checks
-- status IN ('auto_applied','confirmed')). It was specifically
-- manual-then-cron that was open, because this function's own skip-guard
-- only tested 'auto_applied'.
--
-- Fix: one-line change, widening the skip condition to also skip
-- transactions with a 'confirmed' row — mirrors what
-- reconcile_non_check_debits() already does correctly
-- (20260701130000_recon_matcher_v3_keyword_gated.sql:130-134):
--   `AND r.status IN ('auto_applied', 'confirmed')`
--
--   BEFORE: IF EXISTS (SELECT 1 FROM public.finance_reconciliation_log
--                       WHERE bank_bs_id = v_txn.bs_id AND status='auto_applied') THEN CONTINUE; END IF;
--   AFTER:  IF EXISTS (SELECT 1 FROM public.finance_reconciliation_log
--                       WHERE bank_bs_id = v_txn.bs_id
--                         AND status IN ('auto_applied','confirmed')) THEN CONTINUE; END IF;
--
-- 20260624000000_bill_payment_model.sql (which defined the function body
-- below) is ALREADY APPLIED to production, so this is a NEW migration with
-- CREATE OR REPLACE rather than an edit to that file. The body below was
-- pulled directly from production via `pg_get_functiondef` (read-only,
-- through `supabase db dump --linked -s public`) immediately before writing
-- this migration, confirmed byte-identical to the local
-- 20260624000000_bill_payment_model.sql copy — so this replaces the live
-- version exactly, with only the one-line skip-condition change applied.
-- Everything else (check-number extraction, bill lookup/ordering,
-- already_paid audit branch, exact-match auto-apply, mismatch flagging,
-- ON CONFLICT DO NOTHING idempotency, grants) is unchanged.
--
-- Applied by Stokely via MCP after review. Do NOT apply manually.

CREATE OR REPLACE FUNCTION public.reconcile_cleared_checks()
RETURNS TABLE (checked_count INTEGER, auto_applied_count INTEGER, mismatch_count INTEGER,
               already_paid_count INTEGER, no_bill_match INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_txn RECORD; v_bill RECORD; v_check_num TEXT; v_tolerance NUMERIC := 0.01;
  v_checked INTEGER := 0; v_auto_applied INTEGER := 0; v_mismatch INTEGER := 0;
  v_already_paid INTEGER := 0; v_no_match INTEGER := 0;
BEGIN
  FOR v_txn IN
    SELECT t.__bs_id AS bs_id, t.date AS txn_date, t.amount, t.description
    FROM banksync.regent_bank_to_cake_supabase_banksync t
    WHERE t.amount < 0 AND t.description ~* 'CHECK\s*#\s*[0-9]+'
    ORDER BY t.date ASC, t.__bs_id ASC
  LOOP
    v_checked := v_checked + 1;
    v_check_num := (regexp_match(v_txn.description, 'CHECK\s*#\s*0*([0-9]+)', 'i'))[1];
    IF v_check_num IS NULL THEN CONTINUE; END IF;
    -- GAP-A fix: skip if this transaction already has an auto_applied OR
    -- confirmed row (was: 'auto_applied' only). A manually-confirmed
    -- transaction must not be re-scanned and paid against a second bill.
    IF EXISTS (SELECT 1 FROM public.finance_reconciliation_log
               WHERE bank_bs_id = v_txn.bs_id AND status IN ('auto_applied', 'confirmed')) THEN CONTINUE; END IF;

    SELECT * INTO v_bill FROM public.finance_bills
    WHERE LTRIM(payment_ref,'0') = v_check_num AND status != 'void'
    ORDER BY CASE status WHEN 'unpaid' THEN 1 WHEN 'partial' THEN 2 WHEN 'paid' THEN 3 ELSE 4 END, due_date ASC
    LIMIT 1;
    IF NOT FOUND THEN v_no_match := v_no_match + 1; CONTINUE; END IF;

    IF v_bill.status = 'paid' THEN
      INSERT INTO public.finance_reconciliation_log
        (bank_bs_id, bill_id, match_type, bank_amount, bill_amount, bank_date, bank_description, status)
      VALUES (v_txn.bs_id, v_bill.id, 'already_paid', v_txn.amount, v_bill.amount, v_txn.txn_date, v_txn.description, 'pending_review')
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;
      v_already_paid := v_already_paid + 1; CONTINUE;
    END IF;

    IF ABS(ABS(v_txn.amount) - v_bill.amount) <= v_tolerance THEN
      UPDATE public.finance_bills SET status='paid', paid_date=v_txn.txn_date,
        amount_paid=ABS(v_txn.amount), payment_method='check', updated_at=now() WHERE id=v_bill.id;
      INSERT INTO public.finance_reconciliation_log
        (bank_bs_id, bill_id, match_type, bank_amount, bill_amount, bank_date, bank_description, status, applied_at)
      VALUES (v_txn.bs_id, v_bill.id, 'check_exact', v_txn.amount, v_bill.amount, v_txn.txn_date, v_txn.description, 'auto_applied', now())
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;
      v_auto_applied := v_auto_applied + 1;
    ELSE
      INSERT INTO public.finance_reconciliation_log
        (bank_bs_id, bill_id, match_type, bank_amount, bill_amount, bank_date, bank_description, status)
      VALUES (v_txn.bs_id, v_bill.id, 'check_amount_mismatch', v_txn.amount, v_bill.amount, v_txn.txn_date, v_txn.description, 'pending_review')
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;
      v_mismatch := v_mismatch + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_checked, v_auto_applied, v_mismatch, v_already_paid, v_no_match;
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_cleared_checks() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_cleared_checks() TO service_role;

COMMENT ON FUNCTION public.reconcile_cleared_checks() IS
  'Scans banksync for CHECK transactions and reconciles them against finance_bills by check number (payment_ref). '
  'Skips any transaction that already has an auto_applied OR confirmed log row (widened from auto_applied-only '
  'in this migration — SPRO-43 GAP-A — to stop a manually-confirmed transaction being re-scanned and paid '
  'against a second bill by the next cron run). '
  'Bill lookup is status-agnostic: unpaid/partial/paid handled distinctly; void excluded. '
  'Exact amount match (within $0.01): marks bill paid, logs auto_applied. '
  'Amount mismatch (>$0.01): logs pending_review, does NOT pay. '
  'No bill match: increments no_bill_match counter only — no log row. '
  'Idempotent via unique constraint — safe to re-run, including repeated automated runs, now that '
  'confirmed (not just auto_applied) transactions are skipped.';
