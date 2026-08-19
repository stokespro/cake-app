-- SPRO-122: fix reconciliation rows that get stuck in pending_review forever
-- even though the money is already correctly applied.
-- Do NOT apply manually. Joshua applies via Supabase MCP after this PR
-- merges (per this repo's standing "migrate after merge, not before" rule).
--
-- Root cause (confirmed against prod data — 4 stuck rows: checks 323/$421,
-- 324/$252, 325/$296, 507/$2500, all against bills already status='paid'
-- with amount_paid = amount):
--
--   1. reconcile_non_check_debits() creates an amount_only / pending_review
--      row in finance_reconciliation_log for (bank_bs_id, bill_id) — a bank
--      check transaction can clear BEFORE its bill payment is entered.
--   2. Later the payment is entered, and reconcile_cleared_checks() matches
--      the check exactly. It successfully does
--      UPDATE finance_bill_payments SET bank_bs_id = v_txn.bs_id ..., then
--      tries to INSERT the check_exact / auto_applied log row with
--      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING — which silently
--      discards the status promotion because the pending_review row from
--      step 1 already occupies the unique key uq_reconciliation_bank_bill.
--   3. Result: the payment IS correctly linked, but the log row stays
--      pending_review forever, so it never leaves the unreconciled list
--      (app/dashboard/finance/_actions/bank.ts getReconciliationLog filters
--      .eq('status', 'pending_review')).
--   4. Clicking Confirm calls assign_reconciliation_match(). Its LINK branch
--      selects `WHERE bill_id = p_target_bill_id AND bank_bs_id IS NULL` —
--      NOT FOUND, because the payment is already linked to this exact bank
--      transaction. It falls through to the CREATE fallback, inserts a
--      DUPLICATE payment, and fn_finance_bill_payments_guard_overpay()
--      correctly (but unhelpfully) raises BILL_OVERPAY. Confirm can never
--      succeed — the RPC returns success=false, error_code='would_overpay'.
--
-- Fix (two function rewrites, no data repair — see below):
--
--   A. reconcile_cleared_checks(): the exact-match branch's log-row INSERT
--      changes from `ON CONFLICT ... DO NOTHING` to a CONDITIONAL
--      `DO UPDATE ... WHERE finance_reconciliation_log.status =
--      'pending_review'` — promotes a stale amount_only/pending_review
--      proposal to check_exact/auto_applied instead of silently discarding
--      the promotion, while still refusing to touch a row that is already
--      auto_applied/confirmed/dismissed (preserves the existing idempotency
--      guard from 20260730000000_reconcile_cleared_checks_skip_confirmed.sql).
--      Also dismisses sibling pending_review rows for the same bank_bs_id
--      that point at OTHER bills, mirroring the both-sides dismissal
--      assign_reconciliation_match() already does (20260806220000:465-469)
--      — once one bill is confirmed for this bank line, competing proposals
--      against other bills are no longer live suggestions.
--
--   B. assign_reconciliation_match(): adds an already-linked short-circuit
--      ahead of the existing LINK-then-CREATE logic (20260806220000 A2). If
--      a payment on the target bill already carries bank_bs_id =
--      the log row's bank_bs_id, the money is already correctly attached —
--      skip the LINK/CREATE write entirely and fall straight through to the
--      log-row upsert that sets status = 'confirmed'. This makes Confirm
--      idempotent and self-healing: clicking Confirm on any of the 4 rows
--      currently stuck in this state (or any future occurrence, belt-and-
--      braces alongside fix A) now succeeds instead of raising
--      BILL_OVERPAY, and clears them WITHOUT a one-off data-repair UPDATE.
--
-- Security: unchanged from every other finance function — SECURITY
-- DEFINER, SET search_path = public, REVOKE ALL FROM PUBLIC, GRANT EXECUTE
-- TO service_role only.

BEGIN;

-- ============================================================
-- 1. REWRITE: reconcile_cleared_checks() — SPRO-122 fix A
-- ============================================================
-- Identical to the version in 20260805210000_bill_payments_ledger.sql
-- (the latest — 20260806220000_recon_link_payments.sql does not touch this
-- function) except for the exact-match branch's log-row INSERT/ON CONFLICT
-- clause and the new sibling-dismissal statement immediately after it.
-- Everything else — the GAP-A skip-already-applied guard, the check-number
-- extraction, the payment lookup/tie-break, the mismatch branch, the
-- no-match branch, the return shape — is preserved byte-for-byte.

CREATE OR REPLACE FUNCTION public.reconcile_cleared_checks()
RETURNS TABLE (checked_count INTEGER, auto_applied_count INTEGER, mismatch_count INTEGER,
               already_paid_count INTEGER, no_bill_match INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn          RECORD;
  v_payment      RECORD;
  v_check_num    TEXT;
  v_tolerance    NUMERIC := 0.01;  -- $0.01 exact-match tolerance for checks
  v_checked      INTEGER := 0;
  v_auto_applied INTEGER := 0;
  v_mismatch     INTEGER := 0;
  v_already_paid INTEGER := 0;     -- SPRO-82: always 0 now (see COMMENT ON FUNCTION below); kept in
                                    -- the return signature so callers don't need a shape change.
  v_no_match     INTEGER := 0;
BEGIN
  -- Iterate over banksync transactions that look like checks (posted
  -- outflows) — unchanged from the original.
  FOR v_txn IN
    SELECT
      t.__bs_id AS bs_id,
      t.date    AS txn_date,
      t.amount,
      t.description
    FROM banksync.regent_bank_to_cake_supabase_banksync t
    WHERE t.amount < 0
      AND t.description ~* 'CHECK\s*#\s*[0-9]+'
    ORDER BY t.date ASC, t.__bs_id ASC
  LOOP
    v_checked := v_checked + 1;

    -- Extract the digit group only, stripping leading zeros — unchanged.
    v_check_num := (regexp_match(v_txn.description, 'CHECK\s*#\s*0*([0-9]+)', 'i'))[1];
    IF v_check_num IS NULL THEN
      CONTINUE;  -- malformed description — skip without logging
    END IF;

    -- GAP-A guard (unchanged from 20260730000000_reconcile_cleared_checks_skip_confirmed.sql):
    -- skip a transaction that already has an auto_applied OR confirmed log
    -- row, so a manually-confirmed transaction is never re-scanned and
    -- reconciled a second time by the next cron run.
    IF EXISTS (
      SELECT 1 FROM public.finance_reconciliation_log
      WHERE bank_bs_id = v_txn.bs_id
        AND status IN ('auto_applied', 'confirmed')
    ) THEN
      CONTINUE;
    END IF;

    -- SPRO-82: reconciliation now targets a PAYMENT row, not a bill.
    -- finance_bill_payments carries its own check number (payment_ref) and
    -- its own bank_bs_id (NULL = recorded but not yet matched to a cleared
    -- check). A bill can hold several payments now — including more than
    -- one check — so matching straight against the bill (the pre-SPRO-82
    -- behaviour) would be ambiguous the moment a bill has two checks.
    -- Deterministic tie-break if more than one unreconciled check payment
    -- shares this exact check number (should be rare — check numbers are
    -- only conventionally unique per vendor, not enforced globally):
    -- earliest paid_date, then earliest created_at, wins.
    SELECT p.*
    INTO v_payment
    FROM public.finance_bill_payments p
    JOIN public.finance_bills b ON b.id = p.bill_id
    WHERE p.payment_method = 'check'
      AND p.bank_bs_id IS NULL
      AND LTRIM(p.payment_ref, '0') = v_check_num
      AND b.status <> 'void'
    ORDER BY p.paid_date ASC, p.created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
      -- No unreconciled check payment matches this check number — do NOT
      -- log (unchanged FIX 2 behaviour from the original migration).
      -- Covers both "no payment was ever entered with this check number"
      -- and "it already reconciled in an earlier run" — neither is
      -- audit-worthy.
      v_no_match := v_no_match + 1;
      CONTINUE;
    END IF;

    IF ABS(ABS(v_txn.amount) - v_payment.amount) <= v_tolerance THEN
      -- Exact match: reconcile the PAYMENT to the bank transaction only.
      -- Do NOT touch finance_bills — the money was already recorded
      -- (amount_paid/status, via the recompute trigger) the moment the
      -- payment row was entered. Setting bank_bs_id here only marks that
      -- payment as bank-confirmed. This is a DELIBERATE behaviour change
      -- from the pre-SPRO-82 version, which used to set the whole bill
      -- 'paid' from this branch.
      UPDATE public.finance_bill_payments
      SET bank_bs_id = v_txn.bs_id,
          updated_at = now()
      WHERE id = v_payment.id;

      -- SPRO-122 fix: this used to be `ON CONFLICT (bank_bs_id, bill_id)
      -- DO NOTHING`, which silently discarded the promotion to
      -- check_exact/auto_applied whenever an earlier amount_only/
      -- pending_review proposal (from reconcile_non_check_debits(), or a
      -- prior dismissed/confirmed attempt) already occupied this exact
      -- (bank_bs_id, bill_id) key — the payment above got linked correctly,
      -- but the log row stayed pending_review forever, and Confirm on it
      -- could then never succeed (see this migration's header). Fix:
      -- conditionally UPDATE instead. The WHERE clause is LOAD-BEARING — it
      -- refuses to touch a row that is already auto_applied (the
      -- uidx_reconciliation_bank_auto_applied partial unique index already
      -- guarantees GAP-A above would have skipped this bank_bs_id if one
      -- existed, so this is belt-and-braces), confirmed, or dismissed,
      -- preserving 20260730000000's idempotency guard exactly. applied_by
      -- is deliberately left untouched (NULL) on both the INSERT and the
      -- UPDATE branches — this function has no p_user_id, it is a system/
      -- cron reconciliation, same as the pre-existing INSERT never set it.
      INSERT INTO public.finance_reconciliation_log (
        bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
        bank_date, bank_description, status, applied_at
      ) VALUES (
        v_txn.bs_id, v_payment.bill_id, 'check_exact', v_txn.amount, v_payment.amount,
        v_txn.txn_date, v_txn.description, 'auto_applied', now()
      )
      ON CONFLICT (bank_bs_id, bill_id) DO UPDATE SET
        match_type       = 'check_exact',
        status            = 'auto_applied',
        applied_at        = now(),
        bank_amount       = EXCLUDED.bank_amount,
        bill_amount       = EXCLUDED.bill_amount,
        bank_date         = EXCLUDED.bank_date,
        bank_description  = EXCLUDED.bank_description
      WHERE finance_reconciliation_log.status = 'pending_review';

      -- SPRO-122 fix: mirrors the both-sides dismissal
      -- assign_reconciliation_match() already does
      -- (20260806220000_recon_link_payments.sql:465-469). Now that this
      -- bank transaction is confirmed against v_payment.bill_id, any other
      -- pending_review proposal for the SAME bank_bs_id pointing at a
      -- DIFFERENT bill (e.g. an amount_only guess from
      -- reconcile_non_check_debits() made before the check payment was
      -- entered) is a dead suggestion — dismiss it rather than leaving a
      -- second, now-impossible-to-confirm row in the pending list.
      -- applied_by stays NULL, same rationale as above (no user in this
      -- system/cron context).
      UPDATE public.finance_reconciliation_log
      SET status = 'dismissed', applied_at = now()
      WHERE status = 'pending_review'
        AND bank_bs_id = v_txn.bs_id
        AND bill_id != v_payment.bill_id;

      v_auto_applied := v_auto_applied + 1;
    ELSE
      -- Amount differs by more than $0.01 — do NOT reconcile; flag for
      -- review. Changes nothing on finance_bill_payments or finance_bills.
      INSERT INTO public.finance_reconciliation_log (
        bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
        bank_date, bank_description, status
      ) VALUES (
        v_txn.bs_id, v_payment.bill_id, 'check_amount_mismatch', v_txn.amount, v_payment.amount,
        v_txn.txn_date, v_txn.description, 'pending_review'
      )
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;

      v_mismatch := v_mismatch + 1;
    END IF;

  END LOOP;

  RETURN QUERY SELECT v_checked, v_auto_applied, v_mismatch, v_already_paid, v_no_match;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_cleared_checks() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reconcile_cleared_checks() TO service_role;

COMMENT ON FUNCTION public.reconcile_cleared_checks() IS
  'SPRO-122 fix (was SPRO-82, 20260805210000_bill_payments_ledger.sql): reconciles against '
  'finance_bill_payments rows, not finance_bills directly — a bill can hold several payments '
  '(including several checks), so matching straight against the bill is ambiguous. Scans banksync for '
  'CHECK transactions, extracts the check number, and matches it to an unreconciled check payment '
  '(payment_method=''check'', bank_bs_id IS NULL) via payment_ref (leading zeros stripped both sides) '
  'on a non-void bill. '
  'Exact amount match (within $0.01): sets that payment''s bank_bs_id, then UPSERTS the check_exact/'
  'auto_applied log row — CONDITIONAL DO UPDATE (WHERE status = ''pending_review'') rather than DO '
  'NOTHING, so a stale amount_only/pending_review proposal for this same (bank_bs_id, bill_id) key gets '
  'promoted instead of silently blocking the status change forever (SPRO-122: this was the root cause '
  'of reconciliation rows stuck in pending_review despite the payment already being correctly linked — '
  'see this migration''s header). Refuses to touch a row already auto_applied/confirmed/dismissed, '
  'preserving 20260730000000''s idempotency guard. Also dismisses sibling pending_review rows for the '
  'same bank_bs_id pointing at a different bill (mirrors assign_reconciliation_match()''s both-sides '
  'dismissal). Deliberately does NOT write finance_bills — the money was already recorded when the '
  'payment was entered; this only marks it bank-confirmed. '
  'Amount mismatch (>$0.01): logs pending_review, changes nothing. '
  'No matching payment: increments no_bill_match only — no log row (prevents NULL-bill_id flood on '
  're-runs, per the original FIX 2). '
  'Skips any transaction that already has an auto_applied OR confirmed log row (GAP-A, unchanged from '
  '20260730000000_reconcile_cleared_checks_skip_confirmed.sql). '
  'already_paid_count is always 0 — kept in the return signature only so callers do not need a shape '
  'change. '
  'Idempotent via the unique constraint on finance_reconciliation_log — safe to re-run.';


-- ============================================================
-- 2. REWRITE: assign_reconciliation_match() — SPRO-122 fix B
-- ============================================================
-- Identical to the version in 20260806220000_recon_link_payments.sql (the
-- latest) except for one addition: an already-linked short-circuit inserted
-- immediately before the existing "LINK first, CREATE only as a fallback"
-- block (that migration's section A2). Every guard, the exact lock ordering
-- (non-locking bank_bs_id read -> pg_advisory_xact_lock -> FOR UPDATE log
-- row -> FOR UPDATE bill, the NEW-1 deadlock fix), the match_type
-- preservation (A3), and the both-sides dismissal are preserved
-- byte-for-byte.

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
  v_already_linked     BOOLEAN; -- SPRO-122 fix: target bill already has a payment linked to this exact bank_bs_id
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
  -- SPRO-122 fix: already-linked short-circuit.
  -- ============================================================
  -- Does the target bill already have a payment carrying THIS EXACT
  -- bank_bs_id? If so, the money is already correctly attached -- most
  -- commonly because reconcile_cleared_checks() already set it (and, before
  -- the SPRO-122 fix to that function, its own log-row upsert was silently
  -- discarded by ON CONFLICT ... DO NOTHING because a stale pending_review
  -- proposal already occupied uq_reconciliation_bank_bill -- see this
  -- migration's header for the full root cause). Writing the money again
  -- here would be at best a no-op unique-key collision (the LINK branch
  -- below would find nothing, since the payment isn't "unlinked" anymore)
  -- and at worst -- via its CREATE fallback -- a duplicate payment that
  -- fn_finance_bill_payments_guard_overpay() correctly blocks with
  -- BILL_OVERPAY, which is exactly the bug this ticket reports (Confirm
  -- returns error_code = 'would_overpay' and can never succeed). Skip the
  -- LINK/CREATE write entirely and fall straight through to the log-row
  -- upsert below, which just needs to land on status = 'confirmed' -- this
  -- makes Confirm idempotent and self-healing for any row already stuck in
  -- this state, with no one-off data-repair UPDATE required.
  SELECT EXISTS (
    SELECT 1 FROM public.finance_bill_payments
    WHERE bill_id = p_target_bill_id AND bank_bs_id = v_log.bank_bs_id
  ) INTO v_already_linked;

  IF NOT v_already_linked THEN
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
  END IF;
  -- SPRO-122: when v_already_linked was TRUE, both branches above are
  -- skipped entirely -- no money write happens, and execution falls straight
  -- through to the log-row upsert below with the payment already correctly
  -- attached from an earlier run.

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
  'SPRO-122 fix (was SPRO-82 follow-up, 20260806220000_recon_link_payments.sql): the SINGLE '
  'implementation of "attach this bank transaction to this bill" -- Phase B routes '
  'confirmReconciliationMatch through this same RPC instead of carrying its own create-only logic. '
  'New in this migration: an already-linked short-circuit runs BEFORE the LINK/CREATE logic -- if the '
  'target bill already has a payment carrying this exact bank_bs_id (most commonly because '
  'reconcile_cleared_checks() already set it but its own log-row upsert was blocked by a stale '
  'pending_review row -- see the SPRO-122 fix to that function), no money write happens at all; '
  'execution falls straight through to the log-row upsert so status becomes ''confirmed''. This makes '
  'Confirm idempotent and self-healing, fixing rows that were stuck returning error_code = '
  '''would_overpay'' forever with no way to clear them from the UI. '
  'Otherwise-unchanged core behaviour: if the target bill has a payment recorded but not yet linked to '
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
  'Preserves every guard and the exact lock ordering from 20260806220000_recon_link_payments.sql / '
  '20260805210000_bill_payments_ledger.sql / 20260728130000_assign_reconciliation_match_rpc.sql '
  'unchanged: non-locking bank_bs_id read -> pg_advisory_xact_lock -> FOR UPDATE log row -> FOR UPDATE '
  'bill (NEW-1 deadlock fix), bank_txn_spent (one transaction still pays at most one bill -- SPRO-82 '
  'locked decision #2), auto_applied_conflict, bill_void, invalid_amount, check_requires_ref, '
  'not_pending, log_not_found, bill_not_found, target_required, and the both-sides pending dismissal '
  'with BUG-5 applied_by stamping. already_reconciled stays deleted (a bill may be settled by several '
  'bank transactions). '
  'Callable by service_role only -- called from app/dashboard/finance/_actions/bank.ts '
  'assignReconciliationMatch() and confirmReconciliationMatch().';

COMMIT;
