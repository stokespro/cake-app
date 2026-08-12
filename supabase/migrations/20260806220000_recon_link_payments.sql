-- SPRO-82 follow-up: reconciliation must LINK payments, not create them.
-- Phase A of the SPRO-82 recon fix spec (.context/spro-82-recon-fix-spec.md).
-- Amends 20260805210000_bill_payments_ledger.sql, which is already applied
-- to production.
-- Do NOT apply manually. Joshua applies via Supabase MCP after this PR
-- merges (per this repo's standing "migrate after merge, not before" rule).
--
-- The defect: splitting payments into finance_bill_payments (previous
-- migration) turned one operation into two -- recording money in vs linking
-- money to a bank line -- but only reconcile_cleared_checks() was ever
-- converted to "link". confirmReconciliationMatch (Confirm button) and
-- assign_reconciliation_match() (manual assign) still INSERTed a brand new
-- payment on every call. Confirming a proposal on a bill that was already
-- marked paid therefore inserted a SECOND payment, the overpay guard
-- (fn_finance_bill_payments_guard_overpay(), previous migration) correctly
-- blocked it, and the row got stuck. Proven in production (rolled back):
-- "BILL_OVERPAY: Payments would total 3195.00, exceeding the bill amount of
-- 1597.50." 20 of 21 pending reconciliation proposals in production were in
-- exactly this state at spec-writing time -- this is the NORMAL workflow
-- (record the bill paid when it's paid; the bank line clears days later),
-- not an edge case.
--
-- Locked decisions (Joshua):
--   1. Confirm/assign LINKS an already-recorded payment to a bank
--      transaction; it does not create money, except when the bill has no
--      unlinked payment at all (then it IS the payment).
--   2. Amounts must match (within $0.01) to link. A real discrepancy
--      between what was recorded as paid and what the bank cleared must
--      surface as an explicit 'amount_mismatch' error, never be papered
--      over by creating a second payment or silently linking the wrong
--      figure.
--   3. A mistyped/unmatched check number must still produce an
--      amount-based reconciliation proposal rather than vanishing into
--      Untracked with no suggestion at all.
--
-- Objects changed in this file:
--   1. FUNCTION assign_reconciliation_match() -- rewritten core behaviour:
--      link an existing unlinked payment to the bank transaction when one
--      exists and its amount matches (within $0.01); return the new
--      'amount_mismatch' error code when one exists but the amount does
--      not match; return the new 'already_linked' error code in the narrow
--      case where the LINK update itself hits a unique_violation on
--      uidx_fbp_bank_bill (a different payment on this bill already carries
--      this exact bank_bs_id); only fall back to creating a new payment
--      when the bill has no unlinked payment at all. Also preserves the log
--      row's original match_type on a plain Confirm (same bill as
--      originally proposed) instead of always overwriting it with
--      'manual_override'. This makes it the SINGLE implementation of
--      "attach this bank transaction to this bill" -- Phase B (TS) points
--      confirmReconciliationMatch at this same RPC instead of carrying its
--      own divergent create-only logic. Every existing guard (not_pending,
--      log_not_found, bill_not_found, target_required, bill_void,
--      bank_txn_spent, auto_applied_conflict, invalid_amount,
--      check_requires_ref) and the exact lock ordering (non-locking
--      bank_bs_id read -> pg_advisory_xact_lock -> FOR UPDATE log row ->
--      FOR UPDATE bill, the NEW-1 deadlock fix) are preserved byte-for-byte
--      in ordering. already_reconciled stays deleted (removed in the
--      previous migration already -- a bill may take several bank
--      transactions; nothing to do here).
--   2. FUNCTION reconcile_non_check_debits() -- the blanket "exclude every
--      check-looking transaction" filter is replaced with "exclude a check
--      ONLY if its number matches an unreconciled check payment" (i.e. only
--      if reconcile_cleared_checks() could plausibly handle it). A check
--      whose number matches no recorded payment at all (typo, or the
--      payment was never entered with a ref) now falls through to the
--      amount-based matcher instead of disappearing into Untracked with
--      zero suggestions. Verified in production: bank transaction 1113
--      ("CHECK # 283", -$2,079.20) has no unreconciled check payment with
--      ref '283' and would otherwise never get a proposal.
--   3. DATA FIX -- one row: both August commission bills were entered with
--      check ref '284'. The amounts identify which is which (bank check 284
--      = $2,504.00 -> "Commissions - Jay Sisemore"; bank check 283 =
--      $2,079.20 -> "June Commissions Part 2"). Corrects the misassigned
--      ref, guarded so it is a no-op if the data has since changed.
--
-- Security: unchanged from every other finance function -- SECURITY
-- DEFINER, SET search_path = public, REVOKE ALL FROM PUBLIC, GRANT EXECUTE
-- TO service_role only.

BEGIN;

-- ============================================================
-- 1. REWRITE: assign_reconciliation_match()
-- ============================================================
-- Preserves EXACTLY the lock ordering hard-won in
-- 20260728130000_assign_reconciliation_match_rpc.sql (NEW-1 deadlock fix)
-- and carried into 20260805210000_bill_payments_ledger.sql: non-locking
-- read of bank_bs_id -> pg_advisory_xact_lock(bank_bs_id) -> FOR UPDATE log
-- row -> FOR UPDATE bill. Every guard from those migrations is kept:
-- not_pending, log_not_found (x2), target_required, bill_not_found,
-- bill_void, bank_txn_spent, auto_applied_conflict, invalid_amount,
-- check_requires_ref. already_reconciled is (still) gone -- see the
-- SPRO-82 comment left in place below.

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
  v_payment            RECORD;  -- SPRO-82 follow-up: candidate unlinked payment for the LINK branch (A2)
  v_match_type         TEXT;    -- SPRO-82 follow-up: preserved vs. overridden match_type (A3)
  v_upserted_id        UUID;
  v_bank_txn_spent     BOOLEAN;
  v_auto_applied_here  BOOLEAN;
BEGIN
  -- GAP-B fix (SPRO-43 live-testing round, unchanged by SPRO-82): the
  -- bank_txn_spent guard below is a plain non-locking SELECT EXISTS. Under
  -- READ COMMITTED, two concurrent calls that target DIFFERENT log rows and
  -- DIFFERENT bills but share bank_bs_id take disjoint FOR UPDATE lock sets
  -- (one locks log row A + bill X, the other locks log row B + bill Y) --
  -- neither blocks the other, each guard read runs against a snapshot where
  -- the other's not-yet-committed 'confirmed' row is invisible, both pass,
  -- and the inserts land on different (bank_bs_id, bill_id) keys so the
  -- unique constraint doesn't catch it either. Two pending rows for one
  -- transaction against different bills is the NORMAL state (that's why
  -- the both-sides dismissal exists), so there's nothing else in the schema
  -- that would block this race.
  --
  -- Fix: take a session-independent advisory lock keyed on bank_bs_id,
  -- held for the rest of this transaction (xact-scoped -- auto-released on
  -- commit/rollback, no separate unlock needed). This serializes ALL
  -- assign_reconciliation_match calls for a given bank transaction
  -- regardless of which log row or which bill they target, closing the gap
  -- the row-level FOR UPDATE locks below don't cover.
  --
  -- NEW-1 fix (further branch testing, real two-session concurrency):
  -- taking the advisory lock AFTER the log-row FOR UPDATE reproduced a
  -- deadlock -- two concurrent calls acquire the two lock types in OPPOSITE
  -- orders (session B locks its own log row then waits on the advisory
  -- lock; session A holds the advisory lock and its both-sides dismissal
  -- UPDATE needs to write session B's locked row -- circular wait). Fix: a
  -- non-locking read to learn bank_bs_id FIRST, take the advisory lock,
  -- THEN take the row lock -- so the advisory lock is always acquired
  -- before any row lock, on every call, eliminating the ordering conflict.
  -- Two NOT FOUND checks are required: the first for "no such log row at
  -- all", the second for the (narrow) case where the row was deleted
  -- between the non-locking read and the FOR UPDATE re-read.
  SELECT bank_bs_id INTO v_bank_bs_id
  FROM public.finance_reconciliation_log
  WHERE id = p_log_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'log_not_found', 'Log row not found';
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(v_bank_bs_id);

  -- Lock the log row for the rest of this transaction -- serializes
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

  -- Lock the target bill too -- serializes concurrent assigns/confirms that
  -- both touch this bill, and is also the lock
  -- fn_finance_bill_payments_guard_overpay() will re-acquire (harmlessly --
  -- same transaction, same session) when the payment insert below fires it.
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

  -- SPRO-82: the "already_reconciled" guard that used to live here --
  -- refusing to assign a bank transaction to a bill that was already
  -- reconciled (auto_applied/confirmed) against a DIFFERENT transaction --
  -- has been DELETED. A bill may now be settled by SEVERAL bank
  -- transactions: that is the whole point of this ticket (partial payments
  -- need to reach the bank ledger, and a bill needs to be payable more than
  -- once). "This bill already has a reconciled transaction" is therefore no
  -- longer, on its own, an error condition.
  --
  -- The overpay guard trigger on finance_bill_payments
  -- (fn_finance_bill_payments_guard_overpay, previous migration) is what
  -- now stops a bill being settled for more than its amount -- DB-enforced,
  -- and it fires on every insert regardless of how many prior
  -- payments/transactions already exist for this bill. The CREATE branch
  -- below (SPRO-82 follow-up section) is wrapped to translate that guard's
  -- BILL_OVERPAY exception into error_code = 'would_overpay'.
  --
  -- bank_txn_spent immediately below is UNCHANGED and still enforces the
  -- separate, still-standing rule that one bank TRANSACTION may not pay
  -- more than one bill (locked decision #2, SPRO-82 spec) -- that guard was
  -- never about "can a bill have multiple payments", it is about "can one
  -- transaction be split across bills", which stays a deferred future
  -- feature (splitting a bank transaction across bills is out of scope).

  -- BUG-1 fix (SPRO-43): stop the same TRANSACTION paying two different
  -- bills. The unique constraint on finance_reconciliation_log is
  -- (bank_bs_id, bill_id), which explicitly permits many bills per
  -- transaction, so nothing else here catches it. Refuse if this bank
  -- transaction is already reconciled (auto_applied or confirmed) against
  -- ANY other bill. bill_id IS NOT NULL guards out 'untracked' rows (NULL
  -- bill_id) so they never spuriously block; `!= p_target_bill_id` (not IS
  -- DISTINCT FROM) is deliberate for the same reason.
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
  -- THIS exact (bank_bs_id, bill_id) pair -- preserves
  -- reconcile_cleared_checks()'s idempotency guard (unchanged from
  -- 20260728130000).
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

  -- BUG-6 fix (unchanged): hoisted above the payment write so a log row
  -- with a NULL/zero bank_amount can never write a zero-amount payment
  -- (which would also fail finance_bill_payments' own amount > 0 CHECK,
  -- but this gives a clearer, purpose-built error).
  IF v_bank_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'invalid_amount', 'Bank amount must be greater than 0 to apply a payment';
    RETURN;
  END IF;

  -- BUG-4 fix (unchanged): validatePaymentFields() parity -- 'check' method
  -- requires a payment_ref, which this flow never has (dead branch today --
  -- the matcher never emits suggested_payment_method='check' -- kept for
  -- defensive parity).
  IF v_pay_method = 'check' THEN
    RETURN QUERY SELECT FALSE, 'check_requires_ref', 'Check number is required when payment method is check.';
    RETURN;
  END IF;

  -- ============================================================
  -- SPRO-82 follow-up (A2): LINK first, CREATE only as a fallback.
  -- ============================================================
  -- This whole block REPLACES the previous migration's unconditional
  -- upsert into finance_bill_payments (which always INSERTed a new payment
  -- -- the central defect this migration fixes: confirming a proposal on a
  -- bill that was already paid inserted a SECOND payment and the overpay
  -- guard correctly, but unhelpfully, blocked it).
  --
  -- Does this bill already have a payment that is recorded but not yet
  -- linked to ANY bank line? If so, this bank transaction almost certainly
  -- IS that payment clearing -- link it rather than creating a duplicate.
  -- Only when no such payment exists at all does this bank line represent
  -- new money and get INSERTed as its own payment, exactly as before.
  --
  -- v_bank_amount is already guarded > 0 above (invalid_amount).
  SELECT * INTO v_payment
  FROM public.finance_bill_payments
  WHERE bill_id = p_target_bill_id AND bank_bs_id IS NULL
  ORDER BY ABS(amount - v_bank_amount), paid_date, created_at   -- closest amount first, then oldest
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF ABS(v_payment.amount - v_bank_amount) <= 0.01 THEN
      -- LINK. No money is created -- just stamp which bank line this
      -- payment cleared against. paid_date/payment_method/payment_ref are
      -- deliberately NOT overwritten: the payment date is when it was
      -- recorded paid, the bank date is when it cleared -- those are
      -- different facts and both are preserved (the bank date lives on
      -- finance_reconciliation_log, written further below).
      --
      -- Cannot overpay -- this branch moves no money, it only stamps a
      -- foreign key on a row whose amount was already counted in the
      -- bill's total the moment it was recorded. No BILL_OVERPAY exception
      -- handling is needed here (contrast with the CREATE branch below):
      -- being unable to overpay is not the same as being unable to fail.
      --
      -- uidx_fbp_bank_bill is a partial unique index on (bank_bs_id,
      -- bill_id) WHERE bank_bs_id IS NOT NULL -- this UPDATE can violate it
      -- if a DIFFERENT payment on this same bill already carries this
      -- exact bank_bs_id. The path is narrow: auto_applied_conflict above
      -- already catches an 'auto_applied' log row for this
      -- (bank_bs_id, bill_id) pair, and uq_reconciliation_bank_bill on
      -- finance_reconciliation_log covers most of the rest. But this is
      -- money code, not a place to let a raw Postgres unique_violation
      -- string escape to the user, so it gets the same treatment as the
      -- CREATE branch's exception handling below.
      BEGIN
        UPDATE public.finance_bill_payments
        SET bank_bs_id = v_log.bank_bs_id, updated_at = now()
        WHERE id = v_payment.id;
      EXCEPTION
        WHEN unique_violation THEN
          RETURN QUERY SELECT FALSE, 'already_linked',
            'This bank transaction is already linked to a payment on this bill. Refresh and try again.';
          RETURN;
      END;
    ELSE
      -- A real amount discrepancy between what was recorded as paid and
      -- what the bank actually cleared. Per the SPRO-82 locked decision,
      -- this must surface -- never be papered over by creating a second
      -- payment, and never silently linked to the wrong figure.
      RETURN QUERY SELECT FALSE, 'amount_mismatch',
        format('This bill has a recorded payment of %s but the bank transaction is %s. '
               || 'Correct the payment amount on the bill, or pick a different bill.',
               to_char(v_payment.amount, 'FM999999990.00'),
               to_char(v_bank_amount, 'FM999999990.00'));
      RETURN;
    END IF;
  ELSE
    -- No unlinked payment exists for this bill -- nothing has been recorded
    -- for this transaction yet, so this bank line IS the payment (e.g. an
    -- unpaid bill settled by this debit, possibly only partially). The
    -- overpay guard trigger bounds it; its BILL_OVERPAY exception is mapped
    -- to error_code = 'would_overpay' below, same as before.
    --
    -- BUG-2 (payment_ref data loss, pre-ledger): the old single-payment
    -- version hard-nulled finance_bills.payment_ref on every reassignment,
    -- destroying a check number that belonged to a PRIOR partial payment on
    -- the same bill. That class of bug is structurally impossible now --
    -- each payment's payment_ref lives on its own finance_bill_payments row
    -- and is never touched by a different payment's write. This insert
    -- still passes payment_ref = NULL -- the bank-driven reconciliation
    -- path never carries a check number (see BUG-4 above) -- but doing so
    -- no longer risks clobbering anything else's ref.
    BEGIN
      INSERT INTO public.finance_bill_payments
        (bill_id, amount, paid_date, payment_method, payment_ref, bank_bs_id, source, created_by)
      VALUES (p_target_bill_id, v_bank_amount, v_bank_date, v_pay_method, NULL,
              v_log.bank_bs_id, 'bank_manual', p_user_id)
      ON CONFLICT (bank_bs_id, bill_id) WHERE bank_bs_id IS NOT NULL
      DO UPDATE SET amount = EXCLUDED.amount, paid_date = EXCLUDED.paid_date,
                    payment_method = EXCLUDED.payment_method, updated_at = now();
    EXCEPTION
      WHEN check_violation THEN
        IF SQLERRM LIKE 'BILL_OVERPAY:%' THEN
          RETURN QUERY SELECT FALSE, 'would_overpay', SQLERRM;
          RETURN;
        END IF;
        -- Any other check_violation (e.g. BILL_VOID:) is unexpected here --
        -- the v_bill.status = 'void' guard above already rejected a void
        -- bill under the same row lock, so
        -- fn_finance_bill_payments_guard_overpay() should never itself
        -- raise BILL_VOID for this insert. Surface it rather than silently
        -- swallowing an exception class we don't expect.
        RAISE;
    END;
  END IF;

  -- ============================================================
  -- SPRO-82 follow-up (A3): preserve the original match_type on a plain
  -- Confirm; only an actual override gets 'manual_override'.
  -- ============================================================
  -- The previous migration always wrote match_type = 'manual_override'
  -- here, which is right when the user picked a DIFFERENT bill than the
  -- one the log row proposed, but wrong for a plain Confirm (user accepted
  -- the original proposal) -- it destroyed the audit record of how the
  -- match was first proposed (check_exact, card_amount_vendor, amount_only,
  -- ...).
  v_match_type := CASE
    WHEN v_log.bill_id IS NOT DISTINCT FROM p_target_bill_id THEN v_log.match_type
    ELSE 'manual_override'
  END;

  -- Upsert the (bank_bs_id, targetBillId) pairing in the audit log. A row
  -- for this pair may already exist (e.g. dismissed earlier by the matcher
  -- or a prior manual attempt) -- upsert on the same unique constraint the
  -- matcher relies on (uq_reconciliation_bank_bill) rather than
  -- blind-inserting. The auto_applied guard above already ensures we never
  -- clobber that status here.
  INSERT INTO public.finance_reconciliation_log (
    bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
    bank_date, bank_description, status, suggested_payment_method,
    applied_by, applied_at
  ) VALUES (
    v_log.bank_bs_id, p_target_bill_id, v_match_type, v_log.bank_amount, v_bill.amount,
    v_log.bank_date, v_log.bank_description, 'confirmed', v_pay_method,
    p_user_id, now()
  )
  ON CONFLICT (bank_bs_id, bill_id) DO UPDATE SET
    match_type               = v_match_type,
    bank_amount               = EXCLUDED.bank_amount,
    bill_amount               = EXCLUDED.bill_amount,
    bank_date                 = EXCLUDED.bank_date,
    bank_description           = EXCLUDED.bank_description,
    status                     = 'confirmed',
    suggested_payment_method   = EXCLUDED.suggested_payment_method,
    applied_by                 = EXCLUDED.applied_by,
    applied_at                 = EXCLUDED.applied_at
  RETURNING id INTO v_upserted_id;

  -- The user rejected the originally-proposed row -- dismiss it explicitly
  -- (unless it IS the row we just upserted).
  IF v_upserted_id != p_log_id THEN
    UPDATE public.finance_reconciliation_log
    SET status = 'dismissed', applied_by = p_user_id, applied_at = now()
    WHERE id = p_log_id
      AND status = 'pending_review';
  END IF;

  -- Both-sides conflict dismissal, same as confirmReconciliationMatch --
  -- dismiss any other pending_review rows for the same bank_bs_id or the
  -- same target bill, excluding the row we just applied.
  -- BUG-5 fix (unchanged): also stamp applied_by (was missing, unlike the
  -- explicit single-row dismissal above -- sibling dismissals had no
  -- attribution).
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
  'SPRO-82 follow-up: the SINGLE implementation of "attach this bank transaction to this bill" -- '
  'Phase B routes confirmReconciliationMatch through this same RPC instead of carrying its own '
  'create-only logic. Core behaviour: if the target bill has a payment recorded but not yet linked to '
  'any bank line, LINK the closest-amount one (stamp bank_bs_id, no money moves) when it matches within '
  '$0.01; if the closest one does NOT match within $0.01, refuse with error_code = ''amount_mismatch'' '
  '(never silently link or create a second payment for a real discrepancy). The LINK update itself is '
  'wrapped in its own exception handler mapping a unique_violation on uidx_fbp_bank_bill to error_code = '
  '''already_linked'' -- narrow (auto_applied_conflict above and uq_reconciliation_bank_bill on '
  'finance_reconciliation_log cover most of this path), but this is money code: an unhandled '
  'unique_violation must not surface to the user as a raw Postgres error string. Only when the bill has '
  'NO unlinked payment at all does this function CREATE a new payment (the original, still-only-money-'
  'creating branch, wrapped to map fn_finance_bill_payments_guard_overpay()''s BILL_OVERPAY: exception '
  'to error_code = ''would_overpay''). Also preserves the log row''s ORIGINAL match_type (check_exact, '
  'card_amount_vendor, amount_only, ...) when the user confirms the bill the row already proposed, and '
  'only writes ''manual_override'' when they picked a different bill. '
  'Preserves every guard and the exact lock ordering from 20260805210000_bill_payments_ledger.sql / '
  '20260728130000_assign_reconciliation_match_rpc.sql unchanged: non-locking bank_bs_id read -> '
  'pg_advisory_xact_lock -> FOR UPDATE log row -> FOR UPDATE bill (NEW-1 deadlock fix), bank_txn_spent '
  '(one transaction still pays at most one bill -- SPRO-82 locked decision #2), auto_applied_conflict, '
  'bill_void, invalid_amount, check_requires_ref, not_pending, log_not_found, bill_not_found, '
  'target_required, and the both-sides pending dismissal with BUG-5 applied_by stamping. '
  'already_reconciled stays deleted (removed in the previous migration -- a bill may be settled by '
  'several bank transactions). '
  'Callable by service_role only -- called from app/dashboard/finance/_actions/bank.ts '
  'assignReconciliationMatch() and (Phase B) confirmReconciliationMatch().';


-- ============================================================
-- 2. UPDATE: reconcile_non_check_debits() -- A4
-- ============================================================
-- One targeted change: replace the blanket "every check-looking
-- transaction is excluded from the amount-based matcher" filter with
-- "exclude a check ONLY if its number matches an unreconciled check
-- payment" -- i.e. only if reconcile_cleared_checks() could plausibly claim
-- it. A check whose number matches no recorded payment at all (typo on
-- entry, or the payment was never given a ref) used to fall through BOTH
-- matchers and land in Untracked with zero suggestions. Verified against
-- production: ~20 cleared checks had no log row at all, several with
-- exact-amount bill candidates (check 271 -> 2 candidates, check 507 -> 4);
-- bank transaction 1113 ("CHECK # 283", -$2,079.20) is the case fixed by
-- name in this ticket (see the data fix below).
-- Everything else about this function is unchanged from v4/previous
-- migration: the two-phase keyword-gated structure, the 45-day windows,
-- the $0.01 tolerance, the suggested_payment_method CASE, and the
-- remaining-balance comparison for unpaid/partial bills.

CREATE OR REPLACE FUNCTION public.reconcile_non_check_debits()
RETURNS TABLE (scanned_count INTEGER, proposed_count INTEGER, skipped_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn              RECORD;
  v_bill             RECORD;
  v_keyword          TEXT;
  v_keywords         TEXT[];
  v_pay_method       TEXT;
  v_kw_matched       BOOLEAN;
  v_match_type       TEXT;
  v_found_keyword    BOOLEAN;  -- TRUE when Phase 1 produced at least one proposal for this txn
  v_scanned          INTEGER := 0;
  v_proposed         INTEGER := 0;
  v_skipped          INTEGER := 0;
BEGIN
  -- Outer loop: non-check debit transactions not yet auto_applied or
  -- confirmed.
  --
  -- SPRO-82 follow-up (A4): the old filter here was
  -- `AND NOT (t.description ~* 'CHECK\s*#\s*[0-9]+')` -- a blanket
  -- exclusion of every transaction that LOOKS like a check, regardless of
  -- whether that check number matches anything recorded. Replaced with a
  -- targeted NOT EXISTS: only exclude a check whose number matches an
  -- unreconciled check payment (payment_method='check', bank_bs_id IS
  -- NULL, on a non-void bill) -- exactly the set reconcile_cleared_checks()
  -- could plausibly claim. A check with no such match (mistyped ref, or no
  -- ref recorded at all) now reaches Phase 1/Phase 2 below like any other
  -- debit, instead of vanishing into Untracked with no suggestion.
  FOR v_txn IN
    SELECT
      t.__bs_id        AS bs_id,
      t.date           AS txn_date,
      t.amount,
      t.description,
      t.merchant_name
    FROM banksync.regent_bank_to_cake_supabase_banksync t
    WHERE t.amount < 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.finance_bill_payments p
        JOIN public.finance_bills b ON b.id = p.bill_id
        WHERE p.payment_method = 'check'
          AND p.bank_bs_id IS NULL
          AND b.status <> 'void'
          AND LTRIM(p.payment_ref, '0') = (regexp_match(t.description, 'CHECK\s*#\s*0*([0-9]+)', 'i'))[1]
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.finance_reconciliation_log r
        WHERE r.bank_bs_id = t.__bs_id
          AND r.status IN ('auto_applied', 'confirmed')
      )
    ORDER BY t.date ASC, t.__bs_id ASC
  LOOP
    v_scanned       := v_scanned + 1;
    v_found_keyword := FALSE;

    -- Payment method classification (unchanged from v2/v3/v4).
    v_pay_method := CASE
      WHEN v_txn.description ~* '^(DBT\s*CRD|DEBIT\s*CARD)'                          THEN 'card'
      WHEN v_txn.description ~* '(ACH|ELECTRONIC|UTIL_PMNT|UTIL PAYMT|PAYMENT|BILL PAY)' THEN 'ach'
      WHEN v_txn.description ~* '^(WIRE|FEDWIRE)'                                     THEN 'wire'
      WHEN v_txn.description ~* '^TRANSFER'                                            THEN 'transfer'
      ELSE 'other'
    END;

    -- ----------------------------------------------------------
    -- PHASE 1: keyword-matched vendors (confident proposals). Only
    -- considers vendors with a non-empty bank_keywords value. Keyword check
    -- is done in PL/pgSQL after fetching the row so comma-split / LIKE
    -- matching is easier. Bills whose vendor has keywords but NONE of them
    -- match this txn are silently skipped (CONTINUE) and do NOT set
    -- v_found_keyword.
    --
    -- SPRO-82 (previous migration, unchanged here): the amount comparison
    -- uses the bill's REMAINING BALANCE (amount - amount_paid) for
    -- unpaid/partial bills, not the full bill amount -- without this, a
    -- partially-paid bill could never be proposed for its second payment,
    -- which is the whole point of that ticket. A 'paid' bill still compares
    -- against the full amount, unchanged: that branch exists to flag a
    -- suspicious already-paid match, not to find a remaining balance to
    -- fill.
    -- ----------------------------------------------------------
    FOR v_bill IN
      SELECT
        b.id          AS bill_id,
        b.amount      AS bill_amount,
        b.status      AS bill_status,
        b.period_month,
        b.due_date,
        v.bank_keywords
      FROM public.finance_bills b
      JOIN public.finance_vendors v ON v.id = b.vendor_id
      WHERE ABS(ABS(v_txn.amount) - CASE WHEN b.status IN ('unpaid', 'partial')
                                          THEN (b.amount - b.amount_paid)
                                          ELSE b.amount
                                     END) <= 0.01
        AND b.status IN ('unpaid', 'partial', 'paid')  -- 'scheduled' dropped: removed entirely in 20260624000000_bill_payment_model.sql
        AND ABS(b.due_date - v_txn.txn_date) <= 45
        AND v.bank_keywords IS NOT NULL
        AND TRIM(v.bank_keywords) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM public.finance_reconciliation_log r2
          WHERE r2.bank_bs_id = v_txn.bs_id AND r2.bill_id = b.id
        )
      ORDER BY ABS(b.due_date - v_txn.txn_date) ASC, b.period_month DESC
    LOOP
      -- Test each comma-separated keyword against description and
      -- merchant_name -- unchanged.
      v_kw_matched := FALSE;
      v_keywords   := string_to_array(v_bill.bank_keywords, ',');
      FOREACH v_keyword IN ARRAY v_keywords LOOP
        IF LOWER(v_txn.description) LIKE '%' || LOWER(TRIM(v_keyword)) || '%'
           OR (v_txn.merchant_name IS NOT NULL
               AND LOWER(v_txn.merchant_name) LIKE '%' || LOWER(TRIM(v_keyword)) || '%')
        THEN
          v_kw_matched := TRUE;
          EXIT;
        END IF;
      END LOOP;

      -- Vendor has keywords but none matched this transaction -- skip
      -- entirely. Do NOT set v_found_keyword; Phase 2 may still run.
      IF NOT v_kw_matched THEN
        CONTINUE;
      END IF;

      -- At least one keyword matched -- insert a confident proposal.
      v_match_type := CASE WHEN v_bill.bill_status = 'paid'
                           THEN 'already_paid_non_check'
                           ELSE 'card_amount_vendor'
                      END;

      INSERT INTO public.finance_reconciliation_log
        (bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
         bank_date, bank_description, status, suggested_payment_method)
      VALUES
        (v_txn.bs_id, v_bill.bill_id, v_match_type, v_txn.amount, v_bill.bill_amount,
         v_txn.txn_date, v_txn.description, 'pending_review', v_pay_method)
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;

      v_proposed      := v_proposed + 1;
      v_found_keyword := TRUE;   -- suppress Phase 2 for this transaction
    END LOOP;

    -- ----------------------------------------------------------
    -- PHASE 2: amount-only fallback. SKIPPED entirely when Phase 1 found at
    -- least one keyword match. Only considers vendors WITHOUT any
    -- bank_keywords (truly un-mapped). Directional date window: bill due
    -- within 45 days BEFORE the charge or at most 5 days AFTER -- never
    -- weeks into the future. Same remaining-balance rule as Phase 1 above.
    -- ----------------------------------------------------------
    IF NOT v_found_keyword THEN
      FOR v_bill IN
        SELECT
          b.id          AS bill_id,
          b.amount      AS bill_amount,
          b.status      AS bill_status,
          b.period_month,
          b.due_date
        FROM public.finance_bills b
        JOIN public.finance_vendors v ON v.id = b.vendor_id
        WHERE ABS(ABS(v_txn.amount) - CASE WHEN b.status IN ('unpaid', 'partial')
                                            THEN (b.amount - b.amount_paid)
                                            ELSE b.amount
                                       END) <= 0.01
          AND b.status IN ('unpaid', 'partial', 'paid')  -- 'scheduled' dropped: removed entirely in 20260624000000_bill_payment_model.sql
          AND (v.bank_keywords IS NULL OR TRIM(v.bank_keywords) = '')
          AND b.due_date BETWEEN (v_txn.txn_date - INTERVAL '45 days')
                             AND (v_txn.txn_date + INTERVAL '5 days')
          AND NOT EXISTS (
            SELECT 1 FROM public.finance_reconciliation_log r2
            WHERE r2.bank_bs_id = v_txn.bs_id AND r2.bill_id = b.id
          )
        ORDER BY ABS(b.due_date - v_txn.txn_date) ASC, b.period_month DESC
      LOOP
        INSERT INTO public.finance_reconciliation_log
          (bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
           bank_date, bank_description, status, suggested_payment_method)
        VALUES
          (v_txn.bs_id, v_bill.bill_id, 'amount_only', v_txn.amount, v_bill.bill_amount,
           v_txn.txn_date, v_txn.description, 'pending_review', v_pay_method)
        ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;

        v_proposed := v_proposed + 1;
      END LOOP;
    END IF;

  END LOOP;

  RETURN QUERY SELECT v_scanned, v_proposed, v_skipped;
END;
$$;

-- Revoke from all roles; grant only to service_role (same as v1-v4).
REVOKE ALL ON FUNCTION public.reconcile_non_check_debits() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reconcile_non_check_debits() TO service_role;

COMMENT ON FUNCTION public.reconcile_non_check_debits() IS
  'v5 (SPRO-82 follow-up): same keyword-gated two-phase structure as v4 '
  '(20260805210000_bill_payments_ledger.sql), with one change: the blanket check exclusion '
  '(`NOT (description ~* CHECK #...)`) is replaced with a targeted one -- a check-looking transaction is '
  'excluded ONLY if its number matches an unreconciled check payment (payment_method=''check'', '
  'bank_bs_id IS NULL, non-void bill), i.e. only if reconcile_cleared_checks() could plausibly claim it. '
  'A check whose number matches no recorded payment at all now falls through to the amount-based '
  'matcher below instead of disappearing into Untracked with zero suggestions. '
  'Everything else unchanged from v4: (1) the amount comparison uses the bill''s REMAINING BALANCE '
  '(amount - amount_paid) for unpaid/partial bills so a partial bill''s second payment can still be '
  'proposed; ''paid'' bills compare against the full amount. (2) Phase 1: keyword-matched vendor bills '
  '(confident; card_amount_vendor / already_paid_non_check). Phase 2: amount-only fallback against '
  'un-keyworded vendors only, directional date window (due_date <= txn_date + 5 days), skipped entirely '
  'when Phase 1 found a keyword match. Vendors with keywords that do NOT match the bank description are '
  'excluded from both phases. '
  'Callable by service_role only. Never auto-applies -- all proposals go to pending_review.';


-- ============================================================
-- 3. DATA FIX -- one row, guarded (A5)
-- ============================================================
-- Both August commission bills were entered with check ref '284'. The
-- amounts identify which is which: bank check 284 = $2,504.00 (correctly
-- matched to "Commissions - Jay Sisemore"), bank check 283 = $2,079.20 =
-- "June Commissions Part 2". Corrects the misassigned ref on the latter so
-- it can reconcile against the correct bank check going forward (either via
-- reconcile_cleared_checks()'s exact-check-number match, or, per the A4
-- change above, via the amount-based matcher if the check-number match is
-- ever missed again).
--
-- Guarded so this is a no-op if the data has since changed (payment
-- reassigned by hand, amount edited, already linked, etc.) rather than
-- silently touching the wrong row.
--
-- finance_bills.payment_ref is trigger-derived
-- (fn_finance_bill_payments_recompute() -> recompute_bill_totals(),
-- previous migration) from this ledger -- it follows automatically. Do NOT
-- update it directly.
DO $$
DECLARE
  v_moved INTEGER;
BEGIN
  UPDATE public.finance_bill_payments p
  SET payment_ref = '283', updated_at = now()
  FROM public.finance_bills b
  WHERE b.id = p.bill_id
    AND b.name = 'June Commissions Part 2'
    AND p.payment_ref = '284'
    AND p.amount = 2079.20
    AND p.payment_method = 'check'
    AND p.bank_bs_id IS NULL;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RAISE NOTICE 'SPRO-82 follow-up data fix: % row(s) had payment_ref corrected from 284 to 283 on "June Commissions Part 2".', v_moved;
END $$;

COMMIT;
