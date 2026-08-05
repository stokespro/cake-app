// SPRO-77: pure helpers shared by the "Create Bill from an untracked bank
// expense" flow.
//
// These live in their own module (NOT in _actions/bank.ts) for two reasons:
//   1. _actions/bank.ts is a 'use server' file — Next.js only allows async
//      function exports there, so a synchronous helper cannot be exported
//      from it.
//   2. The bills page (a client component) needs these at render time to
//      prefill the create sheet, and unit tests need them without pulling in
//      Supabase.
//
// No imports, no I/O — safe to use from a server action, a client component,
// or a test.

/**
 * Matches a check reference in a bank transaction description and captures the
 * check number with leading zeros stripped.
 *
 * Accepts (case-insensitive):
 *   CHECK # 237 | CHECK #237 | CHECK 237 | CHECK NO 237 | CHECK NO. 237
 *   CHECK NBR 237 | CHECK NUMBER 237 | CK #237 | CHK 237
 *
 * The keyword is bounded on both sides (\b) so debit-card descriptions such as
 * "CHECKCARD 1234" never register as a check.
 *
 * `0*(\d+)` strips leading zeros while always keeping at least one digit —
 * "0237" -> "237", "0000" -> "0". Mirrors reconcile_cleared_checks()'s own
 * extraction (`CHECK\s*#\s*0*([0-9]+)`), widened to the extra spellings above.
 */
const CHECK_NUMBER_RE = /\b(?:check|chk|ck)\b\s*(?:n(?:o|br|um(?:ber)?)\.?)?\s*#?\s*0*(\d+)/i

/**
 * A description that clearly refers to a check but whose number we could not
 * parse — e.g. "CHECK #" with the digits missing or garbled. Requires the '#'
 * marker so ordinary prose containing the word "check" is not caught.
 */
const CHECK_HINT_RE = /\b(?:check|chk|ck)\b\s*(?:n(?:o|br|um(?:ber)?)\.?)?\s*#/i

/**
 * Mirrors reconcile_non_check_debits()'s card classification
 * (20260701130000_recon_matcher_v3_keyword_gated.sql:142).
 */
const CARD_RE = /^\s*(?:DBT\s*CRD|DEBIT\s*CARD)/i

/** Payment methods accepted by finance_bills.payment_method. */
export type BillPaymentMethod = 'card' | 'ach' | 'check' | 'cash'

/**
 * Extracts the check number from a bank transaction description.
 * Returns null when the description contains no parsable check number.
 */
export function parseCheckNumber(description: string | null | undefined): string | null {
  if (!description) return null
  const match = CHECK_NUMBER_RE.exec(description)
  return match ? match[1] : null
}

/**
 * True when the description refers to a check, whether or not the number could
 * be parsed.
 */
export function looksLikeCheck(description: string | null | undefined): boolean {
  if (!description) return false
  return CHECK_NUMBER_RE.test(description) || CHECK_HINT_RE.test(description)
}

/**
 * Derives the payment method (and check number, when there is one) to prefill a
 * bill with, from a bank transaction description.
 *
 * Check handling is deliberate (SPRO-77, Joshua's call): if the description
 * looks like a check but the number can't be parsed we STILL return 'check'
 * with a blank ref, so the bill sheet's own inline validation ("Check number is
 * required when paying by check") asks the user for it. Silently falling back
 * to 'ach' would record a check payment as an ACH.
 *
 * Non-check descriptions collapse to 'card' or 'ach': the SQL matcher's other
 * classifications ('wire', 'transfer', 'other') are all normalized to 'ach' by
 * normalizePaymentMethod() in _actions/bank.ts anyway, so this returns the
 * already-normalized value.
 */
export function derivePrefillPayment(description: string | null | undefined): {
  payment_method: BillPaymentMethod
  payment_ref: string
} {
  if (looksLikeCheck(description)) {
    return { payment_method: 'check', payment_ref: parseCheckNumber(description) ?? '' }
  }
  if (description && CARD_RE.test(description)) {
    return { payment_method: 'card', payment_ref: '' }
  }
  return { payment_method: 'ach', payment_ref: '' }
}
