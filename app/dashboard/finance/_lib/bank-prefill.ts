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

// =======================================================================
// Duplicate-bill detection (SPRO-77 round 2)
// =======================================================================
// Live testing found the real hazard in "Create Bill from an untracked bank
// expense": the transaction may ALREADY have a bill on record that the
// reconciliation matcher structurally cannot see. bs_id 1083 ($22,815,
// "TRANSFER FROM X5514 TO X1210 JTS POS BILL JULY") has a paid "PSO - large"
// bill for the same amount — reconcile_non_check_debits() gates on a vendor
// keyword appearing in the description, and the bank's typo ("POS BILL" for
// "PSO BILL") means the keyword never matches. Creating a bill from that
// transaction silently produces a SECOND paid $22,815 liability.
//
// This window is deliberately AMOUNT + DATE ONLY — no vendor-keyword gating.
// Replicating the matcher's own gating here would reproduce exactly the blind
// spot the warning exists to cover. It is intentionally loose: it is advisory
// (plus a server-side "are you sure" gate), and a human decides.

/** Two amounts are "the same money" within a cent. */
export const DUPLICATE_AMOUNT_TOLERANCE = 0.01

/**
 * Days either side of the bank transaction date to look for an existing bill.
 * Same 45-day window reconcile_non_check_debits() and getMatchCandidates()
 * use, so the warning covers at least everything the matcher would consider.
 */
export const DUPLICATE_WINDOW_DAYS = 45

/** Most candidates ever shown/returned. Beyond this the list stops being useful. */
export const DUPLICATE_CANDIDATE_LIMIT = 10

const MS_PER_DAY = 24 * 60 * 60 * 1000
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** An existing bill that might already cover a given bank transaction. */
export interface DuplicateBillCandidate {
  id: string
  name: string
  vendor_name: string | null
  amount: number
  due_date: string
  status: string
  payment_ref: string | null
}

/**
 * Parses a 'YYYY-MM-DD' date at UTC midnight. Returns null for anything that
 * isn't exactly that shape (including real Date-parseable strings such as
 * '2026-08' or a full timestamp) — callers treat null as "unusable date" and
 * refuse to run the duplicate check rather than silently comparing against
 * an Invalid Date, which would make every comparison false and quietly
 * disable the safeguard.
 */
export function parseIsoDateUtc(date: string | null | undefined): Date | null {
  if (!date || !ISO_DATE_RE.test(date)) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Whole days from `from` to `to` (positive = `to` is later). Null if either
 * date is unusable.
 */
export function daysBetweenIsoDates(from: string, to: string): number | null {
  const a = parseIsoDateUtc(from)
  const b = parseIsoDateUtc(to)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY)
}

/**
 * The inclusive due_date window to search for a duplicate bill, as ISO date
 * strings ready to hand to PostgREST gte/lte. Null when the transaction date
 * is unusable.
 */
export function duplicateDateWindow(
  txnDate: string,
  windowDays: number = DUPLICATE_WINDOW_DAYS
): { minDate: string; maxDate: string } | null {
  const anchor = parseIsoDateUtc(txnDate)
  if (!anchor) return null
  const offset = windowDays * MS_PER_DAY
  return {
    minDate: new Date(anchor.getTime() - offset).toISOString().substring(0, 10),
    maxDate: new Date(anchor.getTime() + offset).toISOString().substring(0, 10),
  }
}

/**
 * True when a bill amount matches a bank amount within the tolerance. Signs are
 * ignored — banksync stores outflows negative, finance_bills.amount is positive.
 *
 * Compared in integer cents, not as floats: `Math.abs(100 - 100.01)` is
 * 0.010000000000005 in IEEE-754, so a plain `<= 0.01` would reject an
 * exactly-one-cent difference that Postgres NUMERIC (which the DB-side window
 * uses) accepts. Same input, two different answers, and the disagreeing case is
 * the boundary this tolerance exists to include.
 */
export function amountsMatch(billAmount: number, bankAmount: number): boolean {
  const cents = (n: number) => Math.round(Math.abs(n) * 100)
  return Math.abs(cents(billAmount) - cents(bankAmount)) <= cents(DUPLICATE_AMOUNT_TOLERANCE)
}

/**
 * Orders duplicate candidates by how close their due date is to the bank
 * transaction date (nearest first) and caps the list. Candidates with an
 * unparsable due date sort last rather than being dropped — a bill that
 * matches the amount is worth showing even if its date is odd.
 *
 * Ties keep their incoming relative order (Array.prototype.sort is stable),
 * so the caller's own secondary ordering survives.
 */
export function rankDuplicateCandidates<T extends { due_date: string }>(
  candidates: T[],
  txnDate: string,
  limit: number = DUPLICATE_CANDIDATE_LIMIT
): T[] {
  const distance = (c: T): number => {
    const days = daysBetweenIsoDates(txnDate, c.due_date)
    return days === null ? Number.POSITIVE_INFINITY : Math.abs(days)
  }
  return [...candidates].sort((a, b) => distance(a) - distance(b)).slice(0, limit)
}

/**
 * Drops candidates already reconciled (auto_applied/confirmed) against a
 * DIFFERENT bank transaction than the one being checked — the recurring-bill
 * false positive. Rent is $5,000/month; June's bill is already linked to
 * June's debit, so July's untracked debit falls inside the amount+date window
 * and would otherwise surface June's ALREADY-SPOKEN-FOR bill as if it were a
 * duplicate of July's payment, telling the user to "match to it instead" of
 * creating July's bill — exactly backwards advice.
 *
 * Pure Set-based filter, split out of findDuplicateBillCandidates()
 * (_actions/bank.ts) purely so the filtering behavior — not the query that
 * feeds it — can be unit-tested without a DB round trip. Mirrors
 * getMatchCandidates()'s identical exclusion (same file, ~line 674) for the
 * same reason: a candidate spoken for elsewhere is never a real duplicate.
 */
export function excludeReconciledElsewhere<T extends { id: string }>(
  candidates: T[],
  excludedIds: Iterable<string>
): T[] {
  const excluded = new Set(excludedIds)
  return candidates.filter((c) => !excluded.has(c.id))
}
