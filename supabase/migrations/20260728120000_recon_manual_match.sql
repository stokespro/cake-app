-- SPRO-43: allow a user to manually assign a bank transaction to a
-- different bill than the auto-suggested match.
--
-- finance_reconciliation_log.match_type currently allows:
--   'check_exact', 'check_amount_mismatch', 'fuzzy_suggested', 'untracked',
--   'already_paid', 'card_amount_vendor', 'amount_only', 'already_paid_non_check'
-- (set in 20260619120000_recon_phase2.sql). This migration widens it to also
-- allow 'manual_override' — set when assignReconciliationMatch() links a bank
-- transaction to a bill the user picked themselves, rather than the one the
-- matcher proposed.
--
-- Applied by Stokely via MCP after review. Do NOT apply manually.

ALTER TABLE public.finance_reconciliation_log
  DROP CONSTRAINT IF EXISTS finance_reconciliation_log_match_type_check;
ALTER TABLE public.finance_reconciliation_log
  ADD CONSTRAINT finance_reconciliation_log_match_type_check
    CHECK (match_type IN (
      'check_exact',
      'check_amount_mismatch',
      'fuzzy_suggested',
      'untracked',
      'already_paid',
      'card_amount_vendor',
      'amount_only',
      'already_paid_non_check',
      'manual_override'
    ));

COMMENT ON COLUMN public.finance_reconciliation_log.match_type IS
  'How this bank transaction was paired with a bill. ''manual_override'' = a user '
  'explicitly picked a different bill than the one originally proposed, via '
  'assignReconciliationMatch() (SPRO-43).';
