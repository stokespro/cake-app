-- SPRO-43 code review fix (P0 #1): make manual reassignment atomic.
--
-- Problem: the previous TS implementation of assignReconciliationMatch()
-- paid the bill via applyBillPayment(), THEN upserted the
-- finance_reconciliation_log row in a separate statement. If the upsert
-- failed (e.g. because the 'manual_override' CHECK constraint from
-- 20260728120000_recon_manual_match.sql hadn't been applied yet — the
-- exact situation at review time), the function returned {success:false}
-- with the bill ALREADY marked paid and no log row recording it. A retry
-- against a different bill would pay that one too, from the same bank
-- transaction. Multiple non-atomic writes from a stateless server action
-- can never be made safe against partial failure — only a single DB
-- transaction can.
--
-- Fix: do the entire operation (re-validate, apply payment, upsert log
-- row, dismiss conflicts) inside one SECURITY DEFINER function, in one
-- transaction. Concurrent calls serialize via SELECT ... FOR UPDATE on
-- both the log row and the target bill row, so:
--   - two rapid clicks on the same candidate: the second call blocks until
--     the first commits, then re-reads status='dismissed' and is rejected.
--   - two different pending_review rows both targeting the same bill: the
--     second call blocks until the first commits, then the "already
--     reconciled against a different bank transaction" guard rejects it
--     using the now-committed data from the first call.
--
-- Also folds in (per review "Also verify" item): refuse to overwrite an
-- existing 'auto_applied' row for the exact (bank_bs_id, bill_id) pair
-- being reassigned. reconcile_cleared_checks()'s idempotency guard
-- (uidx_reconciliation_bank_auto_applied, and the "skip if already
-- auto_applied" check at the top of its loop) relies on that row's
-- status staying 'auto_applied'. Converting it to manual_override/confirmed
-- would make the next cron run re-scan the transaction as if unprocessed.
-- DECISION: refuse rather than silently overwrite. The unique constraint
-- is (bank_bs_id, bill_id) — there is no way to insert a second row for
-- the same pair without either overwriting the existing one (destroys the
-- audit trail + idempotency guard) or refusing (surfaces a clear, rare
-- error and lets a human decide). This situation should only arise if a
-- check already cleanly auto-matched this exact transaction to this exact
-- bill, which is not really a case that needs "assign to a different
-- bill" at all — refusing is the safe default.
--
-- Also (per review #7): adds a composite index on
-- finance_reconciliation_log (bill_id, status), used by getMatchCandidates'
-- now-bounded "already reconciled elsewhere" check and by this function's
-- own guards. Only single-column indexes existed before
-- (20260617100000_banksync_finance_phase1.sql:84-87).
--
-- POST-LIVE-TESTING FIXES (Supabase branch testing found these; atomicity
-- itself was confirmed fixed):
--   BUG-1 (P0, money): the `already_reconciled` guard was keyed on the
--     BILL, not the TRANSACTION — it blocked two transactions -> one bill,
--     but nothing blocked one transaction -> many bills, since
--     uq_reconciliation_bank_bill (bank_bs_id, bill_id) explicitly permits
--     many bills per transaction. Reproduced live: one $500 debit ended up
--     `confirmed` against two separate bills, each marked paid $500 —
--     $1,000 of liabilities cleared by one $500 debit. Root cause:
--     reconcile_cleared_checks() only skips a transaction that already has
--     an `auto_applied` row, not a `confirmed` one, so a manually-confirmed
--     transaction gets a fresh pending_review row on the next cron run.
--     Fix: new `bank_txn_spent` guard, keyed on bank_bs_id, added
--     immediately after `already_reconciled`. The identical hole in
--     confirmReconciliationMatch() (bank.ts) is fixed there too, and
--     getMatchCandidates() now returns no candidates at all for an
--     already-spent bank transaction, so the UI never offers a doomed action.
--   BUG-2 (P1, data loss): the non-paid branch hard-nulled payment_ref on
--     every reassignment, destroying a check number that belonged to a
--     PRIOR partial payment on the same bill. Fixed: stopped writing
--     payment_ref at all (leaves whatever was there — stale is far less
--     harmful than destroyed). amount_paid overwrite-vs-accumulate is a
--     separate business decision, deliberately NOT touched here.
--   BUG-4 (P3): the paid/backfill branch could set payment_method='check'
--     via COALESCE with no payment_ref, while the non-paid branch refuses
--     that exact state. Fixed: check_requires_ref now runs once, before
--     the paid/non-paid split, so both branches are held to the same rule.
--   BUG-5 (P3): the final both-sides dismissal set status/applied_at but
--     not applied_by, unlike the explicit single-row dismissal a few lines
--     above it. Fixed: added applied_by = p_user_id.
--   BUG-6 (P3): the bank_amount <= 0 sanity check only ran in the non-paid
--     branch, so a log row with a NULL/zero bank_amount targeting an
--     already-paid bill could still stamp paid_date/payment_method and
--     write amount_paid = 0. Fixed: hoisted above the paid/non-paid split.
--
-- ROUND 2 FIXES (further branch re-testing; BUG-1 was narrowed, not closed —
-- confirmed to have already produced bad production data via the gap below):
--   GAP-A (P0, money): reconcile_cleared_checks() (separate function, fixed
--     in 20260730000000_reconcile_cleared_checks_skip_confirmed.sql — NOT
--     this file, since 20260624000000_bill_payment_model.sql that defines
--     it is already applied to production) only skipped a transaction with
--     an `auto_applied` row, not a `confirmed` one. So manual-assign-then-
--     cron-run was NOT blocked by this RPC's bank_txn_spent guard (which
--     only covers the manual path) — the cron path re-scanned an already-
--     manually-confirmed transaction and paid a second bill from it.
--     Reproduced live: sum(amount_paid) = 1000.00 off one $500 transaction.
--   GAP-B (P1, concurrency): the bank_txn_spent guard added for BUG-1 is a
--     plain non-locking SELECT EXISTS. Two concurrent assign_reconciliation_
--     match calls that target DIFFERENT log rows and DIFFERENT bills but
--     share bank_bs_id take disjoint FOR UPDATE lock sets, so neither
--     blocks the other, both guard reads run against a snapshot where the
--     other's uncommitted 'confirmed' row is invisible, and both pass.
--     Fixed: PERFORM pg_advisory_xact_lock(...) keyed on bank_bs_id — serializes
--     all assigns for a given bank transaction regardless of target bill.
--     See the guard-block comment below for the full race description and
--     ROUND-3 below for a lock-ORDERING correction to this fix.
--     NOTE: deliberately did NOT add a partial unique index forcing "one
--     bill per transaction" at the schema level — one check legitimately
--     covering multiple vendor invoices is normal AP practice, and whether
--     CAKE does that is still being confirmed with Joshua. The advisory
--     lock closes the concurrency gap without foreclosing that use case.
--
-- ROUND 3 FIX (real two-session concurrency testing on the branch):
--   NEW-1 (P2, deadlock): the advisory lock from GAP-B was taken AFTER the
--     log-row FOR UPDATE. Two concurrent calls then acquired the two lock
--     types in OPPOSITE orders — session B locks its own log row then
--     waits on the advisory lock; session A holds the advisory lock and
--     its both-sides dismissal UPDATE needs to write session B's locked
--     row — circular wait, `deadlock detected`. No money was ever at risk
--     (the victim rolls back completely, exactly one bill gets paid), but
--     the user saw a raw Postgres error string, and victim selection was
--     arbitrary (the first click could be the one that dies).
--     Fixed: a non-locking read to learn bank_bs_id FIRST, take the
--     advisory lock, THEN take the log-row FOR UPDATE lock — so the
--     advisory lock is always acquired before any row lock, on every call.
--     Verified on the branch: identical race now produces no deadlock —
--     one call succeeds, the other blocks then cleanly returns
--     success=false with error_code='not_pending' (the winner's dismissal
--     flips the loser's row status before the loser's re-read observes it —
--     a safe rejection, same family as auto_applied_conflict/bank_txn_spent,
--     and handled the same way client-side: triggers a refetch).
--
-- Applied by Stokely via MCP after review. Do NOT apply manually.
-- Depends on 20260728120000_recon_manual_match.sql (match_type CHECK
-- widened to allow 'manual_override') — filename order guarantees that
-- migration runs first.

CREATE INDEX IF NOT EXISTS idx_recon_log_bill_status
  ON public.finance_reconciliation_log (bill_id, status);

CREATE OR REPLACE FUNCTION public.assign_reconciliation_match(
  p_log_id         UUID,
  p_target_bill_id UUID,
  p_user_id        UUID
)
RETURNS TABLE (
  success       BOOLEAN,
  error_code    TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log               RECORD;
  v_bill               RECORD;
  v_bank_bs_id         BIGINT;
  v_bank_amount        NUMERIC;
  v_bank_date          DATE;
  v_pay_method         TEXT;
  v_target_status      TEXT;
  v_upserted_id        UUID;
  v_already_reconciled BOOLEAN;
  v_bank_txn_spent     BOOLEAN;
  v_auto_applied_here  BOOLEAN;
BEGIN
  -- GAP-B fix (SPRO-43 live-testing round): the bank_txn_spent guard below
  -- is a plain non-locking SELECT EXISTS. Under READ COMMITTED, two
  -- concurrent calls that target DIFFERENT log rows and DIFFERENT bills but
  -- share bank_bs_id take disjoint FOR UPDATE lock sets (one locks log row
  -- A + bill X, the other locks log row B + bill Y) — neither blocks the
  -- other, each guard read runs against a snapshot where the other's
  -- not-yet-committed 'confirmed' row is invisible, both pass, and the
  -- inserts land on different (bank_bs_id, bill_id) keys so the unique
  -- constraint doesn't catch it either. Two pending rows for one
  -- transaction against different bills is the NORMAL state (that's why
  -- the both-sides dismissal exists), so there's nothing else in the
  -- schema that would block this race.
  --
  -- Fix: take a session-independent advisory lock keyed on bank_bs_id,
  -- held for the rest of this transaction (xact-scoped — auto-released on
  -- commit/rollback, no separate unlock needed). This serializes ALL
  -- assign_reconciliation_match calls for a given bank transaction
  -- regardless of which log row or which bill they target, closing the
  -- gap the row-level FOR UPDATE locks below don't cover.
  --
  -- NEW-1 fix (further branch testing, real two-session concurrency):
  -- taking the advisory lock AFTER the log-row FOR UPDATE reproduced a
  -- deadlock — two concurrent calls acquire the two lock types in
  -- OPPOSITE orders (session B locks its own log row then waits on the
  -- advisory lock; session A holds the advisory lock and its both-sides
  -- dismissal UPDATE needs to write session B's locked row — circular
  -- wait). Fix: a non-locking read to learn bank_bs_id FIRST, take the
  -- advisory lock, THEN take the row lock — so the advisory lock is
  -- always acquired before any row lock, on every call, eliminating the
  -- ordering conflict. Two NOT FOUND checks are required: the first for
  -- "no such log row at all", the second for the (narrow) case where the
  -- row was deleted between the non-locking read and the FOR UPDATE re-read.
  SELECT bank_bs_id INTO v_bank_bs_id
  FROM public.finance_reconciliation_log
  WHERE id = p_log_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'log_not_found', 'Log row not found';
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(v_bank_bs_id);

  -- Lock the log row for the rest of this transaction — serializes
  -- concurrent calls against the same suggestion.
  SELECT * INTO v_log
  FROM public.finance_reconciliation_log
  WHERE id = p_log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Row was deleted between the non-locking read above and this re-read.
    RETURN QUERY SELECT FALSE, 'log_not_found', 'Log row not found';
    RETURN;
  END IF;

  IF v_log.status != 'pending_review' THEN
    RETURN QUERY SELECT FALSE, 'not_pending', 'Only pending_review rows can be reassigned';
    RETURN;
  END IF;

  IF p_target_bill_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'target_required', 'A target bill is required';
    RETURN;
  END IF;

  -- Lock the target bill too — serializes concurrent assigns/confirms
  -- that both touch this bill.
  SELECT * INTO v_bill
  FROM public.finance_bills
  WHERE id = p_target_bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'bill_not_found', 'Target bill not found';
    RETURN;
  END IF;

  IF v_bill.status = 'void' THEN
    RETURN QUERY SELECT FALSE, 'bill_void', 'Cannot assign a bank transaction to a voided bill';
    RETURN;
  END IF;

  -- Double-payment guard: refuse if the target bill is already reconciled
  -- (auto_applied or confirmed) against a DIFFERENT bank transaction.
  SELECT EXISTS (
    SELECT 1 FROM public.finance_reconciliation_log
    WHERE bill_id = p_target_bill_id
      AND status IN ('auto_applied', 'confirmed')
      AND bank_bs_id != v_log.bank_bs_id
  ) INTO v_already_reconciled;

  IF v_already_reconciled THEN
    RETURN QUERY SELECT FALSE, 'already_reconciled',
      'This bill is already reconciled against a different bank transaction. Pick another bill.';
    RETURN;
  END IF;

  -- BUG-1 fix: the guard above is keyed on the BILL — it stops the same
  -- bill being paid by two different transactions, but does nothing to
  -- stop the same TRANSACTION paying two different bills (the unique
  -- constraint is (bank_bs_id, bill_id), which explicitly permits many
  -- bills per transaction). Refuse if this bank transaction is already
  -- reconciled (auto_applied or confirmed) against ANY other bill.
  -- bill_id IS NOT NULL guards out 'untracked' rows (NULL bill_id) so they
  -- never spuriously block; `!= p_target_bill_id` (not IS DISTINCT FROM)
  -- is deliberate for the same reason.
  SELECT EXISTS (
    SELECT 1 FROM public.finance_reconciliation_log
    WHERE bank_bs_id = v_log.bank_bs_id
      AND status IN ('auto_applied', 'confirmed')
      AND bill_id IS NOT NULL
      AND bill_id != p_target_bill_id
  ) INTO v_bank_txn_spent;

  IF v_bank_txn_spent THEN
    RETURN QUERY SELECT FALSE, 'bank_txn_spent',
      'This bank transaction is already reconciled against another bill.';
    RETURN;
  END IF;

  -- Audit-trail guard: refuse to overwrite an existing auto_applied row for
  -- THIS exact (bank_bs_id, bill_id) pair — see migration header for why.
  SELECT EXISTS (
    SELECT 1 FROM public.finance_reconciliation_log
    WHERE bank_bs_id = v_log.bank_bs_id
      AND bill_id = p_target_bill_id
      AND status = 'auto_applied'
  ) INTO v_auto_applied_here;

  IF v_auto_applied_here THEN
    RETURN QUERY SELECT FALSE, 'auto_applied_conflict',
      'This transaction was already auto-applied to this bill by check reconciliation. Refresh and try again.';
    RETURN;
  END IF;

  v_bank_amount := ABS(COALESCE(v_log.bank_amount, 0));
  v_bank_date   := COALESCE(v_log.bank_date, CURRENT_DATE);

  -- Mirror normalizePaymentMethod() in bank.ts exactly.
  v_pay_method := CASE
    WHEN v_log.suggested_payment_method IN ('transfer', 'wire', 'ach_transfer') THEN 'ach'
    WHEN v_log.suggested_payment_method IN ('card', 'ach', 'check', 'cash')     THEN v_log.suggested_payment_method
    ELSE 'ach'
  END;

  -- BUG-6 fix: hoisted above the paid/non-paid split. Previously this only
  -- ran in the non-paid branch, so a log row with a NULL/zero bank_amount
  -- targeting an already-paid bill could still stamp paid_date/payment_method
  -- and write amount_paid = 0 via the backfill branch below.
  IF v_bank_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'invalid_amount', 'Bank amount must be greater than 0 to apply a payment';
    RETURN;
  END IF;

  -- BUG-4 fix: hoisted above the paid/non-paid split for the same reason —
  -- validatePaymentFields() parity: 'check' method requires a payment_ref,
  -- which this flow never has (dead branch today — the matcher never emits
  -- suggested_payment_method='check' — kept for defensive parity). Previously
  -- only the non-paid branch enforced this; the paid/backfill branch could
  -- set payment_method='check' via COALESCE with no payment_ref, producing
  -- exactly the state this guard forbids elsewhere.
  IF v_pay_method = 'check' THEN
    RETURN QUERY SELECT FALSE, 'check_requires_ref', 'Check number is required when payment method is check.';
    RETURN;
  END IF;

  -- Mirror applyBillPayment()/markBillPaid() in actions/finance.ts exactly.
  IF v_bill.status = 'paid' THEN
    -- Backfill only missing payment fields — never overwrite an already-paid bill's figures.
    UPDATE public.finance_bills SET
      paid_date      = COALESCE(paid_date, v_bank_date),
      payment_method = COALESCE(payment_method, v_pay_method),
      amount_paid    = CASE WHEN amount_paid IS NULL OR amount_paid = 0 THEN v_bank_amount ELSE amount_paid END,
      updated_at     = now()
    WHERE id = p_target_bill_id;
  ELSE
    v_target_status := CASE WHEN v_bank_amount >= v_bill.amount THEN 'paid' ELSE 'partial' END;

    -- BUG-2 fix: do NOT write payment_ref here. The previous version hard-
    -- nulled it unconditionally, which on a bill that already had a PRIOR
    -- partial payment (its own payment_ref, e.g. a check number) destroyed
    -- that reference. A stale ref left in place is far less harmful than a
    -- destroyed one. (amount_paid is still overwritten, not accumulated —
    -- that's a separate, deliberately untouched business decision.)
    UPDATE public.finance_bills SET
      amount_paid    = v_bank_amount,
      paid_date      = v_bank_date,
      payment_method = v_pay_method,
      status         = v_target_status,
      updated_at     = now()
    WHERE id = p_target_bill_id;
  END IF;

  -- Upsert the (bank_bs_id, targetBillId) pairing. A row for this pair may
  -- already exist (e.g. dismissed earlier by the matcher or a prior manual
  -- attempt) — upsert on the same unique constraint the matcher relies on
  -- (uq_reconciliation_bank_bill) rather than blind-inserting. The
  -- auto_applied guard above already ensures we never clobber that status here.
  INSERT INTO public.finance_reconciliation_log (
    bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
    bank_date, bank_description, status, suggested_payment_method,
    applied_by, applied_at
  ) VALUES (
    v_log.bank_bs_id, p_target_bill_id, 'manual_override', v_log.bank_amount, v_bill.amount,
    v_log.bank_date, v_log.bank_description, 'confirmed', v_pay_method,
    p_user_id, now()
  )
  ON CONFLICT (bank_bs_id, bill_id) DO UPDATE SET
    match_type               = 'manual_override',
    bank_amount               = EXCLUDED.bank_amount,
    bill_amount               = EXCLUDED.bill_amount,
    bank_date                 = EXCLUDED.bank_date,
    bank_description           = EXCLUDED.bank_description,
    status                     = 'confirmed',
    suggested_payment_method   = EXCLUDED.suggested_payment_method,
    applied_by                 = EXCLUDED.applied_by,
    applied_at                 = EXCLUDED.applied_at
  RETURNING id INTO v_upserted_id;

  -- The user rejected the originally-proposed row — dismiss it explicitly
  -- (unless it IS the row we just upserted).
  IF v_upserted_id != p_log_id THEN
    UPDATE public.finance_reconciliation_log
    SET status = 'dismissed', applied_by = p_user_id, applied_at = now()
    WHERE id = p_log_id
      AND status = 'pending_review';
  END IF;

  -- Both-sides conflict dismissal, same as confirmReconciliationMatch —
  -- dismiss any other pending_review rows for the same bank_bs_id or the
  -- same target bill, excluding the row we just applied.
  -- BUG-5 fix: also stamp applied_by (was missing, unlike the explicit
  -- single-row dismissal above — sibling dismissals had no attribution).
  UPDATE public.finance_reconciliation_log
  SET status = 'dismissed', applied_by = p_user_id, applied_at = now()
  WHERE status = 'pending_review'
    AND id != v_upserted_id
    AND (bank_bs_id = v_log.bank_bs_id OR bill_id = p_target_bill_id);

  RETURN QUERY SELECT TRUE, NULL::TEXT, NULL::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_reconciliation_match(UUID, UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.assign_reconciliation_match(UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.assign_reconciliation_match(UUID, UUID, UUID) IS
  'SPRO-43: atomically pairs a bank transaction (via its pending_review finance_reconciliation_log '
  'row) with a user-picked bill instead of the matcher''s suggestion. Single transaction — pay-then-'
  'record is never split across separate statements. Takes pg_advisory_xact_lock(bank_bs_id) BEFORE '
  'any row lock (learned via a non-locking read first) to serialize ALL concurrent calls for a given '
  'bank transaction regardless of which bill they target, THEN row-locks the log row and the target '
  'bill row (FOR UPDATE) — this ordering is deliberate: advisory-lock-after-row-lock reproducibly '
  'deadlocked under real concurrency (two calls acquiring the two lock types in opposite orders). '
  'Refuses to overwrite an existing auto_applied row for the same (bank_bs_id, bill_id) pair to preserve '
  'existing auto_applied row for the same (bank_bs_id, bill_id) pair to preserve '
  'reconcile_cleared_checks()''s idempotency guard. Refuses if the target bill is already reconciled '
  'against a different transaction (already_reconciled) OR if this transaction is already reconciled '
  'against a different bill (bank_txn_spent) — one transaction can never pay more than one bill '
  'through this path. See also reconcile_cleared_checks() (20260730000000_reconcile_cleared_checks_'
  'skip_confirmed.sql) for the equivalent guard on the check-reconciliation path. '
  'Callable by service_role only — called from app/dashboard/finance/_actions/bank.ts assignReconciliationMatch().';
