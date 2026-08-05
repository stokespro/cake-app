-- SPRO-82: bill payment ledger + partial payment reconciliation.
-- Phase A of the SPRO-82 spec (.context/spro-82-spec.md) — schema only.
-- Do NOT apply manually. Joshua applies via Supabase MCP after this PR merges.
--
-- Problem: finance_bills stores exactly one payment inline (status,
-- amount_paid, paid_date, payment_method, payment_ref). Every write path
-- OVERWRITES amount_paid rather than accumulating, so a bill cannot hold two
-- payments, and assign_reconciliation_match() additionally refused
-- ('already_reconciled') when a bill was already matched to another bank
-- transaction. Net effect: partial payments never reached the bank ledger,
-- and a second payment was impossible.
--
-- Fix: reconciliation moves from bill <-> bank_txn to PAYMENT <-> bank_txn.
-- finance_bills.amount_paid / status / paid_date / payment_method /
-- payment_ref become DERIVED columns, maintained by a trigger from the new
-- finance_bill_payments table. They stay real columns so every existing
-- read path (cash-flow projection, weekly budget, month summary, bills
-- table) keeps working untouched.
--
-- Locked decisions (do not revisit — see spec "Decisions" section):
--   1. Payment methods stay exactly card | ach | check | cash. No "RR".
--   2. One bank transaction still maps to at most one bill (the
--      bank_txn_spent guard in assign_reconciliation_match() stays).
--   3. Overpayment is a hard DB-enforced block (payments may never sum past
--      finance_bills.amount) — see fn_finance_bill_payments_guard_overpay()
--      AND fn_finance_bills_guard_amount_reduction() (the latter closes the
--      complementary TOCTOU race on the finance_bills.amount write path
--      itself — see that function's header comment).
--   4. Existing mis-applied bills are NOT data-fixed here. Joshua reassigns
--      them by hand once this ships.
--
-- Objects created/changed in this file:
--   1. TABLE    finance_bill_payments (+ indexes)
--   2. FUNCTION fn_finance_bill_payments_guard_overpay()  (BEFORE trigger)
--   3. FUNCTION fn_finance_bills_guard_amount_reduction() (BEFORE UPDATE OF
--      amount trigger on finance_bills) — DB backstop closing the TOCTOU gap
--      where a concurrent payment could commit between updateBill()'s TS
--      read-then-write, letting amount fall below amount_paid.
--   4. FUNCTION recompute_bill_totals(p_bill_id UUID)
--      FUNCTION fn_finance_bill_payments_recompute()      (AFTER trigger)
--   5. Backfill: 189 pre-existing paid/partial bills -> finance_bill_payments,
--      guarded by RAISE EXCEPTION preconditions and a post-backfill
--      reconciling pass that verifies amount_paid, status, AND paid_date all
--      match their pre-backfill values (all-or-nothing); the INSERT itself
--      is idempotent (skips bills that already have a payment row), so a
--      re-application is a no-op rather than relying solely on the
--      verification rollback to catch it.
--   6. FUNCTION assign_reconciliation_match() — rewritten: deletes the
--      "already_reconciled" (bill-keyed) guard, writes an upsert into
--      finance_bill_payments instead of finance_bills directly.
--   7. FUNCTION reconcile_cleared_checks() — rewritten: matches against
--      finance_bill_payments rows, not bills directly.
--   8. FUNCTION reconcile_non_check_debits() — amount comparison now uses
--      the bill's remaining balance for unpaid/partial bills; drops the
--      dead 'scheduled' status from both phases' filters.
--
-- Security: every new/changed function is SECURITY DEFINER,
-- SET search_path = public, GRANT EXECUTE TO service_role only — no
-- authenticated/anon grants, matching every other finance function.
--
-- No RLS on finance_bill_payments — consistent with every other finance
-- table (see the rationale block at 20260615200000_create_finance_tables.sql
-- lines 3-11: the project relies on app-level role checks, not RLS, for
-- these tables; every server action uses createServiceClient(), which
-- bypasses RLS regardless). Access is gated by requireFinance() in the
-- action layer only (Phase B, not this file).


BEGIN;

-- ============================================================
-- A1. TABLE: finance_bill_payments
-- ============================================================

CREATE TABLE IF NOT EXISTS public.finance_bill_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id        UUID NOT NULL REFERENCES public.finance_bills(id) ON DELETE CASCADE,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_date      DATE NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('card','ach','check','cash')),
  payment_ref    TEXT,
  bank_bs_id     BIGINT,                         -- NULL = recorded but not reconciled to bank
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','bank_auto','bank_manual')),
  notes          TEXT,
  created_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.finance_bill_payments IS
  'SPRO-82: one row per payment applied to a finance_bills row. A bill may now have several '
  'payments (partial payments, multiple checks, etc). finance_bills.amount_paid/status/paid_date/'
  'payment_method/payment_ref are DERIVED from this table by recompute_bill_totals() '
  '(fn_finance_bill_payments_recompute() trigger) — never write those columns directly once this '
  'ships; write a finance_bill_payments row instead.';

COMMENT ON COLUMN public.finance_bill_payments.bank_bs_id IS
  'banksync.__bs_id of the bank transaction this payment reconciles to. NULL = recorded (e.g. a '
  'manually-entered check or cash payment) but not yet matched to a cleared bank transaction — '
  'this is the "payments awaiting bank match" queue (Phase C).';

COMMENT ON COLUMN public.finance_bill_payments.source IS
  '''manual'' = entered directly against a bill (createBill/recordBillPayment). ''bank_auto'' = '
  'reserved for a future fully-automatic match (unused as of SPRO-82). ''bank_manual'' = written by '
  'assign_reconciliation_match() when a user manually pairs a bank transaction with a bill.';

-- No "check requires payment_ref" DB constraint here, deliberately. That
-- validation stays in the action layer (validatePaymentFields in
-- actions/finance.ts, Phase B) — a DB constraint would be a landmine for
-- future backfills of historical data that doesn't cleanly satisfy it.

CREATE INDEX IF NOT EXISTS idx_fbp_bill ON public.finance_bill_payments (bill_id);

-- Partial unique index: a given bank transaction may reconcile to a given
-- bill at most once. NULL bank_bs_id rows (unreconciled) are excluded, so
-- a bill can hold any number of not-yet-reconciled payments.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_fbp_bank_bill
  ON public.finance_bill_payments (bank_bs_id, bill_id) WHERE bank_bs_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fbp_unreconciled
  ON public.finance_bill_payments (paid_date) WHERE bank_bs_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_fbp_check_ref
  ON public.finance_bill_payments (payment_ref) WHERE payment_method = 'check';


-- ============================================================
-- A2. OVERPAY GUARD — BEFORE INSERT OR UPDATE trigger
-- ============================================================
-- DB-enforced hard block: payments may never sum past finance_bills.amount
-- (locked decision #3). The remedy is editing the bill amount first — see
-- updateBill's own would_overpay guard in actions/finance.ts (Phase B),
-- which is the app-level mirror of this same rule for that path.

CREATE OR REPLACE FUNCTION public.fn_finance_bill_payments_guard_overpay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill  RECORD;
  v_total NUMERIC;
BEGIN
  -- Lock the parent bill so concurrent inserts/updates against the SAME
  -- bill serialize on this check — two payments racing to fill the last $1
  -- of a bill must not both read a stale total and both pass.
  SELECT * INTO v_bill
  FROM public.finance_bills
  WHERE id = NEW.bill_id
  FOR UPDATE;

  -- Should be unreachable in practice — bill_id has a NOT NULL FK to
  -- finance_bills — but the FK itself is enforced as a separate constraint
  -- trigger that fires AFTER this BEFORE trigger, so guard against
  -- dereferencing a NULL v_bill below rather than relying on that ordering.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND: Bill % does not exist.', NEW.bill_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_bill.status = 'void' THEN
    RAISE EXCEPTION 'BILL_VOID: Cannot record a payment against a voided bill. Un-void the bill first.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Sum every OTHER payment already on this bill, plus the row being
  -- written now. `id <> NEW.id` is safe on INSERT too: NEW.id is already
  -- populated from the column DEFAULT by the time a BEFORE ROW trigger
  -- runs, so it never spuriously excludes the row itself and never matches
  -- an unrelated row either.
  SELECT COALESCE(SUM(amount), 0) INTO v_total
  FROM public.finance_bill_payments
  WHERE bill_id = NEW.bill_id
    AND id <> NEW.id;

  v_total := v_total + NEW.amount;

  -- amount is NUMERIC (exact) on both sides — plain > is correct, no float
  -- epsilon needed.
  IF v_total > v_bill.amount THEN
    RAISE EXCEPTION 'BILL_OVERPAY: Payments would total %, exceeding the bill amount of %. Edit the bill amount first, or reduce this payment.',
      v_total, v_bill.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_bill_payments_guard_overpay ON public.finance_bill_payments;
CREATE TRIGGER trg_finance_bill_payments_guard_overpay
  BEFORE INSERT OR UPDATE ON public.finance_bill_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_finance_bill_payments_guard_overpay();

REVOKE ALL ON FUNCTION public.fn_finance_bill_payments_guard_overpay() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_finance_bill_payments_guard_overpay() TO service_role;

COMMENT ON FUNCTION public.fn_finance_bill_payments_guard_overpay() IS
  'SPRO-82: BEFORE INSERT OR UPDATE guard on finance_bill_payments. Locks the parent bill (FOR '
  'UPDATE), then refuses (RAISE EXCEPTION, prefix BILL_OVERPAY: or BILL_VOID:) if this write would '
  'push the bill''s total payments past its amount, or if the bill is void. The TS layer '
  '(actions/finance.ts, Phase B) pattern-matches these prefixes to return errorCode ''would_overpay'' '
  '/ ''bill_void'' instead of a raw Postgres error.';


-- ============================================================
-- A2b. AMOUNT-REDUCTION GUARD — BEFORE UPDATE OF amount ON finance_bills
-- ============================================================
-- Hardening fix (adversarial review of this migration): the overpay guard
-- above only fires on writes to finance_bill_payments. Nothing stopped
-- `UPDATE finance_bills SET amount = ...` from shrinking a bill's amount
-- below what has already been paid against it. actions/finance.ts
-- updateBill() checks this in TS (read amount_paid, compare, then write) but
-- that is a read-then-write with no row lock — a classic TOCTOU race:
--
--   Bill amount $1,000, amount_paid $0. Admin A calls updateBill(amount:
--   $100) — passes the TS check (amount_paid is still 0 at read time).
--   Concurrently, Admin B (or the reconciliation cron) records a $900
--   payment — valid at that moment, since amount is still $1,000, and it
--   commits first (and, via the AFTER trigger below, writes amount_paid =
--   900 to this same bill). A's stale UPDATE then lands, unopposed.
--   Final state: amount $100, amount_paid $900. Overpaid, with nothing in
--   the DB to have caught it.
--
-- Overpayment being impossible is a hard product requirement (SPRO-82 spec,
-- locked decision #3) — a TS-only, lock-free check is not a sufficient
-- enforcement point for a hard requirement. This trigger is the DB backstop
-- for that same rule on the finance_bills.amount write path, mirroring
-- fn_finance_bill_payments_guard_overpay()'s BILL_OVERPAY: prefix
-- convention so the existing TS mapPaymentDbErrorCode()/
-- stripPaymentErrorPrefix() handling (lib/finance/bill-payments.ts)
-- classifies it as errorCode 'would_overpay' with no TS change required.
--
-- Scope: `BEFORE UPDATE OF amount` (column-list trigger) plus a `WHEN
-- (OLD.amount IS DISTINCT FROM NEW.amount)` clause — belt AND braces, so
-- this can only ever fire on a write that actually changes the value, never
-- as a side effect of an UPDATE statement that happens to also touch other
-- columns. This matters because recompute_bill_totals() (A3 below) itself
-- runs `UPDATE public.finance_bills SET amount_paid = ..., status = ...,
-- paid_date = ..., payment_method = ..., payment_ref = ..., updated_at =
-- now() WHERE id = p_bill_id` — it never sets amount, so this trigger does
-- not fire for that statement and cannot deadlock or reject the very
-- recompute that keeps the ledger honest.
--
-- Verified against every other writer of finance_bills in this codebase:
--   - INSERT paths (createBill in actions/finance.ts) are unaffected — this
--     is an UPDATE-only trigger.
--   - setBillVoid() (actions/finance.ts) writes only status/updated_at
--     (and, when un-voiding, reads amount/amount_paid but never writes
--     amount) — does not fire this trigger.
--   - assign_reconciliation_match() (A5 below) and reconcile_cleared_checks()
--     (A6 below) write finance_bill_payments only; finance_bills is touched
--     solely via recompute_bill_totals(), which never sets amount.
--   - app/dashboard/finance/_actions/bank.ts has no direct `.update()` of
--     finance_bills.amount anywhere (confirmed by inspection) — every write
--     there is either to finance_reconciliation_log or routed through the
--     RPCs/recompute above.
--   - updateBill() (actions/finance.ts) is the ONLY legitimate writer of
--     finance_bills.amount, and it is exactly the path this trigger is
--     meant to backstop — its own TS pre-check becomes redundant-but-safe
--     defense in depth once this trigger exists, not a load-bearing guard.

CREATE OR REPLACE FUNCTION public.fn_finance_bills_guard_amount_reduction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- amount is NUMERIC (exact) on both sides — plain < is correct, no float
  -- epsilon needed.
  IF NEW.amount < OLD.amount_paid THEN
    RAISE EXCEPTION 'BILL_OVERPAY: Cannot reduce the bill amount to %, below the % already recorded in payments. Delete or reduce a payment first.',
      NEW.amount, OLD.amount_paid
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Row-level UPDATE ... FOR UPDATE / trigger firing on finance_bills is
-- already serialized per-row by Postgres's own MVCC row locking (the second
-- writer's UPDATE blocks until the first commits, then re-evaluates OLD
-- against the now-committed row) — no explicit SELECT ... FOR UPDATE is
-- needed here the way the overpay guard above needs one against a
-- *different* table's aggregate.
DROP TRIGGER IF EXISTS trg_finance_bills_guard_amount_reduction ON public.finance_bills;
CREATE TRIGGER trg_finance_bills_guard_amount_reduction
  BEFORE UPDATE OF amount ON public.finance_bills
  FOR EACH ROW
  WHEN (OLD.amount IS DISTINCT FROM NEW.amount)
  EXECUTE FUNCTION public.fn_finance_bills_guard_amount_reduction();

REVOKE ALL ON FUNCTION public.fn_finance_bills_guard_amount_reduction() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_finance_bills_guard_amount_reduction() TO service_role;

COMMENT ON FUNCTION public.fn_finance_bills_guard_amount_reduction() IS
  'SPRO-82 hardening: BEFORE UPDATE OF amount trigger on finance_bills (fires only when amount '
  'actually changes — WHEN (OLD.amount IS DISTINCT FROM NEW.amount)). DB backstop for updateBill()''s '
  'own TS pre-check, closing a TOCTOU race where a concurrent payment could commit between '
  'updateBill()''s read and its write. Refuses (RAISE EXCEPTION, prefix BILL_OVERPAY:, same '
  'convention as fn_finance_bill_payments_guard_overpay()) if the new amount would fall below '
  'OLD.amount_paid. Does not fire for recompute_bill_totals()''s UPDATE (A3 below), which never sets '
  'amount, nor for any INSERT path.';


-- ============================================================
-- A3. RECOMPUTE — AFTER INSERT OR UPDATE OR DELETE trigger
-- ============================================================
-- Keeps finance_bills.amount_paid/status/paid_date/payment_method/
-- payment_ref in sync with finance_bill_payments so every existing read
-- path (cash-flow projection, weekly budget, month summary, bills table)
-- keeps working untouched.

CREATE OR REPLACE FUNCTION public.recompute_bill_totals(p_bill_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill   RECORD;
  v_total  NUMERIC;
  v_latest RECORD;
BEGIN
  SELECT * INTO v_bill
  FROM public.finance_bills
  WHERE id = p_bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Bill was deleted (ON DELETE CASCADE already removed its payments
    -- too) — nothing to recompute.
    RETURN;
  END IF;

  -- Never touch a voided bill's derived columns. Voiding is its own path
  -- (setBillVoid(), Phase B) and is not modeled as "zero payments" — a void
  -- bill keeps whatever amount_paid/status it had at the moment it was
  -- voided, for audit purposes.
  IF v_bill.status = 'void' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_total
  FROM public.finance_bill_payments
  WHERE bill_id = p_bill_id;

  -- "Latest" payment feeds the derived paid_date/payment_method/
  -- payment_ref columns: highest paid_date, tie-broken by created_at.
  -- Mirror: lib/finance/bill-payments.ts computeBillTotals() (Phase D) —
  -- keep the two in lockstep, per that file's header comment, the same way
  -- normalizePaymentMethod() is mirrored between bank.ts and this SQL.
  SELECT paid_date, payment_method, payment_ref
  INTO v_latest
  FROM public.finance_bill_payments
  WHERE bill_id = p_bill_id
  ORDER BY paid_date DESC, created_at DESC
  LIMIT 1;

  -- amount is NUMERIC (exact) on both sides — plain >= is correct, no float
  -- epsilon needed.
  UPDATE public.finance_bills SET
    amount_paid    = v_total,
    status         = CASE
                        WHEN v_total <= 0             THEN 'unpaid'
                        WHEN v_total >= v_bill.amount THEN 'paid'
                        ELSE 'partial'
                      END,
    paid_date      = CASE WHEN v_total <= 0 THEN NULL ELSE v_latest.paid_date END,
    payment_method = CASE WHEN v_total <= 0 THEN NULL ELSE v_latest.payment_method END,
    payment_ref    = CASE WHEN v_total <= 0 THEN NULL ELSE v_latest.payment_ref END,
    updated_at     = now()
  WHERE id = p_bill_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_bill_totals(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.recompute_bill_totals(UUID) TO service_role;

COMMENT ON FUNCTION public.recompute_bill_totals(UUID) IS
  'SPRO-82: recomputes finance_bills.amount_paid/status/paid_date/payment_method/payment_ref from '
  'the sum and latest row of finance_bill_payments for one bill. Called per-row by '
  'fn_finance_bill_payments_recompute(), and called directly (once per bill, bulk) by this '
  'migration''s backfill reconciling pass below. No-op on a void bill. '
  'Mirror: lib/finance/bill-payments.ts computeBillTotals() (Phase D) — keep the two in lockstep.';

CREATE OR REPLACE FUNCTION public.fn_finance_bill_payments_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_bill_totals(OLD.bill_id);
    RETURN OLD;
  END IF;

  PERFORM public.recompute_bill_totals(NEW.bill_id);

  -- A payment moving between bills (bill_id reassigned on UPDATE) is not a
  -- flow any Phase B server action exposes today, but the trigger has to
  -- stay correct if it ever happens: recompute the OLD bill too, so it
  -- doesn't keep crediting a payment that no longer belongs to it.
  IF TG_OP = 'UPDATE' AND NEW.bill_id IS DISTINCT FROM OLD.bill_id THEN
    PERFORM public.recompute_bill_totals(OLD.bill_id);
  END IF;

  RETURN NEW;
END;
$$;

-- finance_bills has no triggers of its own (confirmed: no CREATE TRIGGER
-- anywhere in supabase/migrations/ targets finance_bills) — the UPDATE
-- inside recompute_bill_totals() above cannot recurse back into this
-- trigger or fire anything else.
DROP TRIGGER IF EXISTS trg_finance_bill_payments_recompute ON public.finance_bill_payments;
CREATE TRIGGER trg_finance_bill_payments_recompute
  AFTER INSERT OR UPDATE OR DELETE ON public.finance_bill_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_finance_bill_payments_recompute();

REVOKE ALL ON FUNCTION public.fn_finance_bill_payments_recompute() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_finance_bill_payments_recompute() TO service_role;

COMMENT ON FUNCTION public.fn_finance_bill_payments_recompute() IS
  'SPRO-82: AFTER INSERT OR UPDATE OR DELETE trigger on finance_bill_payments. Delegates to '
  'recompute_bill_totals() for NEW.bill_id (and OLD.bill_id too, on DELETE or on an UPDATE that '
  'moves a payment to a different bill) so finance_bills stays in sync with the payment ledger.';


-- ============================================================
-- A4. BACKFILL — existing paid/partial bills -> finance_bill_payments
-- ============================================================
-- Verified against production before writing the SPRO-82 spec: 189 bills
-- with amount_paid > 0 and status <> 'void', all with a non-null paid_date
-- and payment_method, zero already overpaid, zero with payment_method =
-- 'check' and a blank payment_ref, zero voided bills with amount_paid > 0.
-- Assert these hold AT APPLY TIME and abort (RAISE EXCEPTION) rather than
-- silently skip rows if any assumption no longer holds — this migration is
-- all-or-nothing.
--
-- Note: these assertions check the underlying INVARIANTS the spec verified
-- (non-null paid_date/payment_method, no overpay, no blank check ref, no
-- void-with-amount), not the literal row count of 189. New bills that get
-- legitimately paid between the spec being written and this migration
-- being applied would increase that count without violating any invariant,
-- and should still backfill cleanly — pinning to exactly 189 rows would
-- make the migration fail for a change that isn't actually a problem.

DO $$
DECLARE
  v_missing_paid_info INTEGER;
  v_overpaid           INTEGER;
  v_blank_check_ref     INTEGER;
  v_void_with_amount    INTEGER;
BEGIN
  -- Precondition 1: every bill with amount_paid > 0 and status <> 'void'
  -- must have a non-null paid_date AND payment_method — the backfill INSERT
  -- below reads both straight off finance_bills, and finance_bill_payments
  -- has NOT NULL constraints on both.
  SELECT count(*) INTO v_missing_paid_info
  FROM public.finance_bills
  WHERE amount_paid > 0 AND status <> 'void'
    AND (paid_date IS NULL OR payment_method IS NULL);

  IF v_missing_paid_info > 0 THEN
    RAISE EXCEPTION 'SPRO-82 backfill precondition failed: % bill(s) have amount_paid > 0, status <> ''void'', and a NULL paid_date or payment_method. Aborting migration.', v_missing_paid_info;
  END IF;

  -- Precondition 2: no bill is already overpaid (amount_paid > amount).
  -- The backfilled payment row must satisfy the exact same rule
  -- fn_finance_bill_payments_guard_overpay() will enforce on every future
  -- write, and the backfill runs with triggers disabled (so this guard
  -- would not catch it at insert time).
  SELECT count(*) INTO v_overpaid
  FROM public.finance_bills
  WHERE amount_paid > 0 AND status <> 'void'
    AND amount_paid > amount;

  IF v_overpaid > 0 THEN
    RAISE EXCEPTION 'SPRO-82 backfill precondition failed: % bill(s) have amount_paid > amount (already overpaid). Per the SPRO-82 spec these are NOT to be data-fixed by this migration — Joshua reassigns them by hand after this ships. Aborting migration.', v_overpaid;
  END IF;

  -- Precondition 3: no bill paid by check has a blank/NULL payment_ref.
  -- finance_bill_payments deliberately has no DB-level "check requires ref"
  -- constraint (see A1), but the backfilled row's payment_ref feeds
  -- reconcile_cleared_checks()'s check-number lookup below — a blank ref
  -- here would silently make that bill's check unreconcilable going forward.
  SELECT count(*) INTO v_blank_check_ref
  FROM public.finance_bills
  WHERE amount_paid > 0 AND status <> 'void'
    AND payment_method = 'check'
    AND (payment_ref IS NULL OR TRIM(payment_ref) = '');

  IF v_blank_check_ref > 0 THEN
    RAISE EXCEPTION 'SPRO-82 backfill precondition failed: % bill(s) have payment_method = ''check'' and a blank payment_ref. Aborting migration.', v_blank_check_ref;
  END IF;

  -- Precondition 4: no voided bill carries amount_paid > 0. The backfill
  -- below deliberately excludes status = 'void' bills (recompute_bill_totals()
  -- never touches a void bill either), so money sitting on a void bill
  -- would otherwise be silently dropped from the new ledger.
  SELECT count(*) INTO v_void_with_amount
  FROM public.finance_bills
  WHERE status = 'void' AND amount_paid > 0;

  IF v_void_with_amount > 0 THEN
    RAISE EXCEPTION 'SPRO-82 backfill precondition failed: % voided bill(s) have amount_paid > 0. Aborting migration.', v_void_with_amount;
  END IF;
END $$;

-- Snapshot pre-backfill amount_paid, status, AND paid_date for every bill in
-- scope, so the reconciling pass below can prove ALL THREE trigger-derived
-- values match what was already on the row before this migration touched
-- anything — not just amount_paid. recompute_bill_totals() derives
-- amount_paid, status, paid_date, payment_method, and payment_ref together
-- from the same SUM/latest-row computation; checking only amount_paid would
-- let a status- or paid_date-derivation bug slip through undetected even
-- though the header above claims this pass proves "the derived values
-- match" (plural). payment_method/payment_ref are intentionally not
-- snapshotted: with exactly one payment row per bill (this backfill inserts
-- one row per bill, never more), the "latest payment" is trivially that row,
-- so payment_method/payment_ref are copied from the same source columns
-- they're being compared against and cannot independently diverge the way a
-- derived status or a tie-broken paid_date could.
DROP TABLE IF EXISTS tmp_spro82_prebackfill;
CREATE TEMP TABLE tmp_spro82_prebackfill AS
SELECT id, amount_paid AS pre_amount_paid, status AS pre_status, paid_date AS pre_paid_date
FROM public.finance_bills
WHERE amount_paid > 0 AND status <> 'void';

-- Disable both finance_bill_payments triggers for the bulk insert so the
-- AFTER trigger doesn't recompute-and-rewrite finance_bills once per row
-- (up to 189 times) during the insert. USER excludes only internal system
-- triggers (e.g. FK enforcement), not either of the two triggers created
-- above — both are disabled here.
ALTER TABLE public.finance_bill_payments DISABLE TRIGGER USER;

-- 159 of the 189 bills have exactly one confirmed/auto_applied
-- reconciliation-log row (bank_bs_id is unambiguous). 5 have several — the
-- earliest (by bank_date, then created_at) wins; Joshua reassigns the
-- remainder by hand afterwards (locked decision #4). That is expected and
-- must not be treated as an error.
--
-- Idempotency (hardening fix): guarded by `WHERE NOT EXISTS (... a payment
-- already exists for this bill)` so re-running this migration is an
-- explicit no-op rather than inserting a second payment row per bill. The
-- transaction wrapper (BEGIN/COMMIT around the whole file) plus the
-- verification block below already catch a duplicate insert and roll the
-- whole migration back — that was already fail-safe — but this makes
-- re-application a clean no-op instead of relying on that rollback.
INSERT INTO public.finance_bill_payments
  (bill_id, amount, paid_date, payment_method, payment_ref, bank_bs_id, source, created_by, created_at)
SELECT b.id, b.amount_paid, b.paid_date, b.payment_method, b.payment_ref,
       (SELECT r.bank_bs_id FROM public.finance_reconciliation_log r
         WHERE r.bill_id = b.id AND r.status IN ('auto_applied','confirmed')
         ORDER BY r.bank_date NULLS LAST, r.created_at LIMIT 1),
       'manual', b.created_by, b.created_at
FROM public.finance_bills b
WHERE b.amount_paid > 0 AND b.status <> 'void'
  AND NOT EXISTS (
    SELECT 1 FROM public.finance_bill_payments p WHERE p.bill_id = b.id
  );

ALTER TABLE public.finance_bill_payments ENABLE TRIGGER USER;

-- Reconciling pass: now that triggers are back on, recompute every
-- backfilled bill exactly once via the same helper the triggers use
-- (functionally identical to re-firing the AFTER trigger for each row,
-- without actually re-touching finance_bill_payments).
SELECT public.recompute_bill_totals(id) FROM tmp_spro82_prebackfill;

-- Verify: the recomputed amount_paid, status, AND paid_date must all
-- exactly match what was already on the bill before the backfill touched
-- anything. recompute_bill_totals() derives all three (plus
-- payment_method/payment_ref) from the same computation, so checking only
-- amount_paid would let a status- or paid_date-derivation bug slip through
-- silently — checking all three is what actually proves "the derived values
-- match" (plural), as this migration's header claims. Any mismatch means
-- the backfill and the recompute trigger disagree — abort the whole
-- migration rather than loosen this check.
--
-- Verified against live production data before this hardening pass: 0 of
-- the 189 in-scope bills' stored `status` disagrees with the
-- amount_paid-vs-amount derivation recompute_bill_totals() applies, and all
-- 189 already have a non-null paid_date (enforced by precondition 1 above)
-- equal to their own single backfilled payment's paid_date — so this
-- stricter check passes cleanly on current production data, same as the
-- amount_paid-only check it replaces.
DO $$
DECLARE
  v_mismatch_count INTEGER;
BEGIN
  SELECT count(*) INTO v_mismatch_count
  FROM tmp_spro82_prebackfill t
  JOIN public.finance_bills b ON b.id = t.id
  WHERE b.amount_paid IS DISTINCT FROM t.pre_amount_paid
     OR b.status      IS DISTINCT FROM t.pre_status
     OR b.paid_date    IS DISTINCT FROM t.pre_paid_date;

  IF v_mismatch_count > 0 THEN
    RAISE EXCEPTION 'SPRO-82 backfill verification failed: % bill(s) have a trigger-recomputed amount_paid, status, or paid_date that differs from the pre-backfill value. Aborting migration.', v_mismatch_count;
  END IF;
END $$;

DROP TABLE tmp_spro82_prebackfill;


-- ============================================================
-- A5. REWRITE: assign_reconciliation_match()
-- ============================================================
-- Keeps the lock ordering EXACTLY as hard-won in
-- 20260728130000_assign_reconciliation_match_rpc.sql (NEW-1 deadlock fix):
-- non-locking read of bank_bs_id -> pg_advisory_xact_lock(bank_bs_id) ->
-- FOR UPDATE log row -> FOR UPDATE bill. Every guard from that migration
-- (bank_txn_spent, auto_applied_conflict, bill_void, invalid_amount,
-- check_requires_ref, not_pending, log_not_found, bill_not_found,
-- target_required) is preserved. The only guard removed is
-- "already_reconciled" (see the comment in its place below) — that is the
-- central unblock for this ticket. The direct finance_bills UPDATE is
-- replaced with an upsert into finance_bill_payments; the recompute trigger
-- (A3 above) derives finance_bills from that.

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
  v_upserted_id        UUID;
  v_bank_txn_spent     BOOLEAN;
  v_auto_applied_here  BOOLEAN;
BEGIN
  -- GAP-B fix (SPRO-43 live-testing round, unchanged by SPRO-82): the
  -- bank_txn_spent guard below is a plain non-locking SELECT EXISTS. Under
  -- READ COMMITTED, two concurrent calls that target DIFFERENT log rows and
  -- DIFFERENT bills but share bank_bs_id take disjoint FOR UPDATE lock sets
  -- (one locks log row A + bill X, the other locks log row B + bill Y) —
  -- neither blocks the other, each guard read runs against a snapshot where
  -- the other's not-yet-committed 'confirmed' row is invisible, both pass,
  -- and the inserts land on different (bank_bs_id, bill_id) keys so the
  -- unique constraint doesn't catch it either. Two pending rows for one
  -- transaction against different bills is the NORMAL state (that's why
  -- the both-sides dismissal exists), so there's nothing else in the schema
  -- that would block this race.
  --
  -- Fix: take a session-independent advisory lock keyed on bank_bs_id,
  -- held for the rest of this transaction (xact-scoped — auto-released on
  -- commit/rollback, no separate unlock needed). This serializes ALL
  -- assign_reconciliation_match calls for a given bank transaction
  -- regardless of which log row or which bill they target, closing the gap
  -- the row-level FOR UPDATE locks below don't cover.
  --
  -- NEW-1 fix (further branch testing, real two-session concurrency):
  -- taking the advisory lock AFTER the log-row FOR UPDATE reproduced a
  -- deadlock — two concurrent calls acquire the two lock types in OPPOSITE
  -- orders (session B locks its own log row then waits on the advisory
  -- lock; session A holds the advisory lock and its both-sides dismissal
  -- UPDATE needs to write session B's locked row — circular wait). Fix: a
  -- non-locking read to learn bank_bs_id FIRST, take the advisory lock,
  -- THEN take the row lock — so the advisory lock is always acquired
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

  -- Lock the target bill too — serializes concurrent assigns/confirms that
  -- both touch this bill, and is also the lock
  -- fn_finance_bill_payments_guard_overpay() will re-acquire (harmlessly —
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

  -- SPRO-82: the "already_reconciled" guard that used to live here —
  -- refusing to assign a bank transaction to a bill that was already
  -- reconciled (auto_applied/confirmed) against a DIFFERENT transaction —
  -- has been DELETED. A bill may now be settled by SEVERAL bank
  -- transactions: that is the whole point of this ticket (partial payments
  -- need to reach the bank ledger, and a bill needs to be payable more than
  -- once). "This bill already has a reconciled transaction" is therefore no
  -- longer, on its own, an error condition.
  --
  -- The overpay guard trigger on finance_bill_payments
  -- (fn_finance_bill_payments_guard_overpay, A2 above) is what now stops a
  -- bill being settled for more than its amount — DB-enforced, and it fires
  -- on every insert regardless of how many prior payments/transactions
  -- already exist for this bill. The INSERT below is wrapped to translate
  -- that guard's BILL_OVERPAY exception into error_code = 'would_overpay'.
  --
  -- bank_txn_spent immediately below is UNCHANGED and still enforces the
  -- separate, still-standing rule that one bank TRANSACTION may not pay
  -- more than one bill (locked decision #2, SPRO-82 spec) — that guard was
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
  -- THIS exact (bank_bs_id, bill_id) pair — preserves
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

  -- BUG-6 fix (unchanged): hoisted above the payment insert so a log row
  -- with a NULL/zero bank_amount can never write a zero-amount payment
  -- (which would also fail finance_bill_payments' own amount > 0 CHECK,
  -- but this gives a clearer, purpose-built error).
  IF v_bank_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'invalid_amount', 'Bank amount must be greater than 0 to apply a payment';
    RETURN;
  END IF;

  -- BUG-4 fix (unchanged): validatePaymentFields() parity — 'check' method
  -- requires a payment_ref, which this flow never has (dead branch today —
  -- the matcher never emits suggested_payment_method='check' — kept for
  -- defensive parity).
  IF v_pay_method = 'check' THEN
    RETURN QUERY SELECT FALSE, 'check_requires_ref', 'Check number is required when payment method is check.';
    RETURN;
  END IF;

  -- SPRO-82: replaces the old "Mirror applyBillPayment()/markBillPaid()"
  -- IF v_bill.status = 'paid' THEN <backfill-only-update> ELSE
  -- <overwrite-update> END IF block that used to sit here and wrote
  -- finance_bills directly. That whole distinction existed only because one
  -- payment per bill forced it (an already-paid bill had nowhere else to
  -- put a second reconciliation's figures except "backfill missing
  -- fields"). Now every case is the same: upsert a finance_bill_payments
  -- row; fn_finance_bill_payments_recompute() (A3) derives finance_bills.
  --
  -- BUG-2 (payment_ref data loss, pre-SPRO-82): the old non-paid branch
  -- hard-nulled finance_bills.payment_ref on every reassignment, destroying
  -- a check number that belonged to a PRIOR partial payment on the same
  -- bill. That whole class of bug is now structurally impossible: each
  -- payment's payment_ref lives on its own finance_bill_payments row and is
  -- never touched by a different payment's write. This insert still passes
  -- payment_ref = NULL, same as before — the bank-driven reconciliation
  -- path never carries a check number (see BUG-4 above) — but doing so no
  -- longer risks clobbering anything else's ref.
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
      -- Any other check_violation (e.g. BILL_VOID:) is unexpected here —
      -- the v_bill.status = 'void' guard above already rejected a void bill
      -- under the same row lock, so fn_finance_bill_payments_guard_overpay()
      -- should never itself raise BILL_VOID for this insert. Surface it
      -- rather than silently swallowing an exception class we don't expect.
      RAISE;
  END;

  -- Upsert the (bank_bs_id, targetBillId) pairing in the audit log. A row
  -- for this pair may already exist (e.g. dismissed earlier by the matcher
  -- or a prior manual attempt) — upsert on the same unique constraint the
  -- matcher relies on (uq_reconciliation_bank_bill) rather than
  -- blind-inserting. The auto_applied guard above already ensures we never
  -- clobber that status here.
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
  -- BUG-5 fix (unchanged): also stamp applied_by (was missing, unlike the
  -- explicit single-row dismissal above — sibling dismissals had no
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
  'SPRO-82: rewritten to write a finance_bill_payments row (upsert, ON CONFLICT (bank_bs_id, bill_id) '
  'WHERE bank_bs_id IS NOT NULL) instead of updating finance_bills directly — '
  'fn_finance_bill_payments_recompute() derives finance_bills from the ledger. The bill-keyed '
  '"already_reconciled" guard from SPRO-43 is deleted: a bill may now be settled by several bank '
  'transactions (see the SPRO-82 comment in the function body for the full rationale). Everything '
  'else from 20260728130000_assign_reconciliation_match_rpc.sql is preserved unchanged: the lock '
  'ordering (non-locking bank_bs_id read -> pg_advisory_xact_lock -> FOR UPDATE log row -> FOR UPDATE '
  'bill, from the NEW-1 deadlock fix), bank_txn_spent (one transaction still pays at most one bill — '
  'SPRO-82 locked decision #2), auto_applied_conflict, bill_void, invalid_amount, check_requires_ref, '
  'not_pending, log_not_found, bill_not_found, target_required, and the both-sides pending dismissal '
  'with BUG-5 applied_by stamping. New: a BEGIN/EXCEPTION WHEN check_violation block maps the payment '
  'insert''s BILL_OVERPAY: exception (raised by fn_finance_bill_payments_guard_overpay(), A2) to '
  'error_code = ''would_overpay''. '
  'Callable by service_role only — called from app/dashboard/finance/_actions/bank.ts assignReconciliationMatch().';


-- ============================================================
-- A6. REWRITE: reconcile_cleared_checks()
-- ============================================================
-- Matches cleared checks against PAYMENTS, not bills — a check number now
-- lives on a finance_bill_payments row (guaranteed by the A4 backfill).

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

      INSERT INTO public.finance_reconciliation_log (
        bank_bs_id, bill_id, match_type, bank_amount, bill_amount,
        bank_date, bank_description, status, applied_at
      ) VALUES (
        v_txn.bs_id, v_payment.bill_id, 'check_exact', v_txn.amount, v_payment.amount,
        v_txn.txn_date, v_txn.description, 'auto_applied', now()
      )
      ON CONFLICT (bank_bs_id, bill_id) DO NOTHING;

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
  'SPRO-82: rewritten to reconcile against finance_bill_payments rows, not finance_bills directly — '
  'a bill can now hold several payments (including several checks), so matching straight against the '
  'bill is ambiguous. Scans banksync for CHECK transactions, extracts the check number, and matches '
  'it to an unreconciled check payment (payment_method=''check'', bank_bs_id IS NULL) via payment_ref '
  '(leading zeros stripped both sides) on a non-void bill. '
  'Exact amount match (within $0.01): sets that payment''s bank_bs_id, logs auto_applied. Deliberately '
  'does NOT write finance_bills — the money was already recorded when the payment was entered; this '
  'only marks it bank-confirmed (behaviour change from the pre-SPRO-82 version, which set the bill '
  '''paid'' from this branch). '
  'Amount mismatch (>$0.01): logs pending_review, changes nothing. '
  'No matching payment: increments no_bill_match only — no log row (prevents NULL-bill_id flood on '
  're-runs, per the original FIX 2). '
  'Skips any transaction that already has an auto_applied OR confirmed log row (GAP-A, unchanged from '
  '20260730000000_reconcile_cleared_checks_skip_confirmed.sql). '
  'already_paid_count is always 0 now — the old already_paid branch (an audit log for a check clearing '
  'against an already-''paid''-status bill) no longer applies once matching is payment-scoped; a paid '
  'bill can still legitimately have an unreconciled check payment component. Kept in the return '
  'signature only so callers do not need a shape change. '
  'Idempotent via the unique constraint on finance_reconciliation_log — safe to re-run.';


-- ============================================================
-- A7. UPDATE: reconcile_non_check_debits()
-- ============================================================
-- One targeted change plus one cleanup, both requested by the spec: the
-- amount comparison uses the bill's REMAINING BALANCE for unpaid/partial
-- bills (not the full amount), so a partial bill's second payment can be
-- proposed at all; and the dead 'scheduled' status is dropped from both
-- phases' filters (status was removed from finance_bills entirely in
-- 20260624000000_bill_payment_model.sql — this filter was stale).
-- Everything else is unchanged from v3
-- (20260701130000_recon_matcher_v3_keyword_gated.sql): the two-phase
-- keyword-gated structure, the 45-day windows, the $0.01 tolerance, and the
-- suggested_payment_method CASE expression.

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
  -- confirmed — unchanged.
  FOR v_txn IN
    SELECT
      t.__bs_id        AS bs_id,
      t.date           AS txn_date,
      t.amount,
      t.description,
      t.merchant_name
    FROM banksync.regent_bank_to_cake_supabase_banksync t
    WHERE t.amount < 0
      AND NOT (t.description ~* 'CHECK\s*#\s*[0-9]+')
      AND NOT EXISTS (
        SELECT 1 FROM public.finance_reconciliation_log r
        WHERE r.bank_bs_id = t.__bs_id
          AND r.status IN ('auto_applied', 'confirmed')
      )
    ORDER BY t.date ASC, t.__bs_id ASC
  LOOP
    v_scanned       := v_scanned + 1;
    v_found_keyword := FALSE;

    -- Payment method classification (unchanged from v2/v3).
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
    -- SPRO-82: the amount comparison now uses the bill's REMAINING BALANCE
    -- (amount - amount_paid) for unpaid/partial bills, not the full bill
    -- amount — without this, a partially-paid bill could never be proposed
    -- for its second payment, which is the whole point of this ticket. A
    -- 'paid' bill still compares against the full amount, unchanged: that
    -- branch exists to flag a suspicious already-paid match, not to find a
    -- remaining balance to fill.
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
      -- merchant_name — unchanged.
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

      -- Vendor has keywords but none matched this transaction — skip
      -- entirely. Do NOT set v_found_keyword; Phase 2 may still run.
      IF NOT v_kw_matched THEN
        CONTINUE;
      END IF;

      -- At least one keyword matched — insert a confident proposal.
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
    -- within 45 days BEFORE the charge or at most 5 days AFTER — never
    -- weeks into the future. Same SPRO-82 remaining-balance change as
    -- Phase 1 above.
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

-- Revoke from all roles; grant only to service_role (same as v1/v2/v3).
REVOKE ALL ON FUNCTION public.reconcile_non_check_debits() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reconcile_non_check_debits() TO service_role;

COMMENT ON FUNCTION public.reconcile_non_check_debits() IS
  'v4 (SPRO-82): same keyword-gated two-phase structure as v3 '
  '(20260701130000_recon_matcher_v3_keyword_gated.sql), with two changes: '
  '(1) the amount comparison uses the bill''s REMAINING BALANCE (amount - amount_paid) for '
  'unpaid/partial bills instead of the full amount, so a partial bill''s second payment can be '
  'proposed at all — without this a partially-paid bill could never be matched again. ''paid'' bills '
  'still compare against the full amount (unchanged; that branch flags a suspicious already-paid '
  'match, it does not look for a remaining balance). '
  '(2) the dead ''scheduled'' status is dropped from both phases'' bill filters (status was removed '
  'from finance_bills entirely in 20260624000000_bill_payment_model.sql; the filter here was stale). '
  'Phase 1: keyword-matched vendor bills (confident; card_amount_vendor / already_paid_non_check). '
  'Phase 2: amount-only fallback against un-keyworded vendors only, directional date window '
  '(due_date <= txn_date + 5 days), skipped entirely when Phase 1 found a keyword match. Vendors with '
  'keywords that do NOT match the bank description are excluded from both phases. '
  'Callable by service_role only. Never auto-applies — all proposals go to pending_review.';

COMMIT;
