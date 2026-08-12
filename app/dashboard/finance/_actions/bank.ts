'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { requireFinance } from '@/lib/auth/session'
import { createBill } from '@/actions/finance'
import type { BillStatus } from '@/actions/finance'
import { VALID_PAYMENT_METHODS, stripPaymentErrorPrefix } from '@/lib/finance/bill-payments'
import type { PaymentMethod } from '@/lib/finance/bill-payments'
import {
  derivePrefillPayment,
  duplicateDateWindow,
  excludeReconciledElsewhere,
  rankDuplicateCandidates,
  DUPLICATE_AMOUNT_TOLERANCE,
} from '@/app/dashboard/finance/_lib/bank-prefill'
import type { DuplicateBillCandidate } from '@/app/dashboard/finance/_lib/bank-prefill'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

// ============================================================
// TYPES
// ============================================================

export interface BankBalance {
  current_balance: number
  available_balance: number
  pending_balance: number
  account_number: string
  as_of_date: string
  account_name: string
  bank: string
  account_id: string
}

export interface BankTransaction {
  bs_id: number
  id: string
  txn_date: string
  amount: number
  description: string
  original_description: string | null
  merchant_name: string | null
  category: string | null
  type: string | null
}

export type ReconMatchType =
  | 'check_exact'
  | 'check_amount_mismatch'
  | 'fuzzy_suggested'
  | 'untracked'
  | 'already_paid'
  | 'card_amount_vendor'
  | 'amount_only'
  | 'already_paid_non_check'
  | 'manual_override'

export type ReconStatus = 'auto_applied' | 'pending_review' | 'confirmed' | 'dismissed'

export interface MatchCandidate {
  id: string
  name: string
  vendor_name: string | null
  status: 'unpaid' | 'paid' | 'partial' | 'void'
  due_date: string
  amount: number
  payment_ref: string | null
  /** True if the candidate's amount is within $0.01 of the bank transaction amount */
  amount_matches: boolean
  /** due_date minus bank_date, in whole days (negative = due before the txn) */
  days_from_txn: number
}

export interface ReconciliationLogRow {
  id: string
  bank_bs_id: number
  bill_id: string | null
  match_type: ReconMatchType
  bank_amount: number | null
  bill_amount: number | null
  bank_date: string | null
  bank_description: string | null
  status: ReconStatus
  suggested_payment_method: string | null
  applied_at: string | null
  applied_by: string | null
  created_at: string
  // joined
  bill_name: string | null
}

export interface ReconciliationCounts {
  checked_count: number
  auto_applied_count: number
  mismatch_count: number
  already_paid_count: number
  no_bill_match: number
}

// ============================================================
// SECURITY GATE
// ============================================================
// All functions in this file call SECURITY DEFINER RPCs that are
// EXECUTE-granted to service_role only. Two layers of protection:
//   1. createServiceClient() — uses SUPABASE_SERVICE_ROLE_KEY; never
//      reaches the browser; only possible inside a server action.
//   2. requireFinance() — verifies the crm-session HttpOnly cookie
//      server-side and re-reads the user's role from public.users.
//      Identity and role are NEVER accepted from the client. FAIL CLOSED.

// ============================================================
// getBankBalance
// ============================================================

export async function getBankBalance(): Promise<{
  success: boolean
  data?: BankBalance | null
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase.rpc('get_bank_balance')

    if (error) {
      console.error('getBankBalance error:', error)
      return { success: false, error: error.message }
    }

    // rpc returns array for set-returning functions
    const row = Array.isArray(data) ? data[0] : data
    return { success: true, data: (row as BankBalance) ?? null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// runReconciliation
// ============================================================

export async function runReconciliation(): Promise<{
  success: boolean
  data?: ReconciliationCounts
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase.rpc('reconcile_cleared_checks')

    if (error) {
      console.error('runReconciliation error:', error)
      return { success: false, error: error.message }
    }

    const row = Array.isArray(data) ? data[0] : data
    return { success: true, data: row as ReconciliationCounts }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// getReconciliationLog
// ============================================================

export async function getReconciliationLog(
  filter: 'pending' | 'cleared' = 'pending'
): Promise<{
  success: boolean
  data?: ReconciliationLogRow[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    let query = supabase
      .from('finance_reconciliation_log')
      .select(`
        id,
        bank_bs_id,
        bill_id,
        match_type,
        bank_amount,
        bill_amount,
        bank_date,
        bank_description,
        status,
        suggested_payment_method,
        applied_at,
        applied_by,
        created_at,
        bill:finance_bills(name)
      `)
      .order('bank_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (filter === 'pending') {
      query = query.eq('status', 'pending_review')
    } else {
      // cleared = recently auto-applied or confirmed, last 30 days
      const since = new Date()
      since.setDate(since.getDate() - 30)
      query = query
        .in('status', ['auto_applied', 'confirmed'])
        .gte('created_at', since.toISOString())
    }

    const { data, error } = await query

    if (error) {
      console.error('getReconciliationLog error:', error)
      return { success: false, error: error.message }
    }

    const rows: ReconciliationLogRow[] = (data ?? []).map((r) => {
      const billData = r.bill as { name: string } | { name: string }[] | null
      const billName = Array.isArray(billData) ? (billData[0]?.name ?? null) : (billData?.name ?? null)
      return {
        id: r.id,
        bank_bs_id: r.bank_bs_id,
        bill_id: r.bill_id,
        match_type: r.match_type as ReconMatchType,
        bank_amount: r.bank_amount,
        bill_amount: r.bill_amount,
        bank_date: r.bank_date,
        bank_description: r.bank_description,
        status: r.status as ReconStatus,
        suggested_payment_method: r.suggested_payment_method ?? null,
        applied_at: r.applied_at,
        applied_by: r.applied_by,
        created_at: r.created_at,
        bill_name: billName,
      }
    })

    return { success: true, data: rows }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// Shared helpers (used by confirmReconciliationMatch AND
// assignReconciliationMatch so "how do we attach a bank transaction to a
// bill" is defined exactly once — see the SPRO-82 follow-up spec's opening
// paragraph: three divergent implementations of that operation is what
// caused the original bug).
// ============================================================

/**
 * Normalize a reconciliation-derived payment method to a value accepted by
 * finance_bill_payments.payment_method (card | ach | check | cash). Reconciliation
 * keyword detection can yield 'transfer', 'wire', 'ach_transfer', or null —
 * none of which are valid bill payment methods. Map transfer/wire variants
 * → 'ach'; anything else not in the valid set → 'ach'.
 *
 * Mirrors the CASE in supabase/migrations/20260728130000_assign_reconciliation_match_rpc.sql:305-309
 * exactly (that SQL comment reads "Mirror normalizePaymentMethod() in
 * bank.ts exactly." — keep both in lockstep on any future change).
 */
function normalizePaymentMethod(raw: string | null | undefined): PaymentMethod {
  const rawMethod = raw ?? ''
  return rawMethod === 'transfer' || rawMethod === 'wire' || rawMethod === 'ach_transfer'
    ? 'ach'
    : (VALID_PAYMENT_METHODS as readonly string[]).includes(rawMethod)
      ? (rawMethod as PaymentMethod)
      : 'ach'
}

// Mirrors the error_code values assign_reconciliation_match() can return
// (supabase/migrations/20260806220000_recon_link_payments.sql).
// BUG-3 fix (SPRO-43 live-testing round): error_code was declared and
// threaded through the RPC but never actually read by the caller — every
// rejection reason rendered as the same generic toast. 'auto_applied_conflict'
// and 'bank_txn_spent' specifically mean the CALLER'S VIEW IS STALE (someone
// else reconciled this bill/transaction between page load and this click),
// so those two also trigger a data refresh, not just an error toast.
//
// SPRO-82: 'already_reconciled' is now UNREACHABLE — the RPC's rewrite
// deletes that guard entirely, because a bill may now be settled by several
// bank transactions (that removal is the central unblock of this ticket).
// Left in the union rather than removed so any in-flight client still
// checking for it doesn't hit a type error. 'would_overpay' is raised only
// when the RPC's payment INSERT (the "no unlinked payment yet, this bank
// line IS the payment" fallback) would push the bill's total past its
// amount — the RPC wraps that INSERT in `BEGIN ... EXCEPTION WHEN
// check_violation` and maps a 'BILL_OVERPAY:' message to this code.
//
// SPRO-82 follow-up: 'amount_mismatch' is new — the target bill already has
// an unlinked payment recorded, but its amount differs from the bank
// transaction by more than $0.01. The RPC LINKS an existing payment rather
// than creating a second one (spec A2), and refuses rather than silently
// creating a mismatched second payment or overwriting the recorded amount.
// The accompanying error message names both figures.
export type AssignMatchErrorCode =
  | 'log_not_found'
  | 'not_pending'
  | 'target_required'
  | 'bill_not_found'
  | 'bill_void'
  | 'already_reconciled' // SPRO-82: unreachable — see comment above
  | 'bank_txn_spent'
  | 'auto_applied_conflict'
  | 'invalid_amount'
  | 'check_requires_ref'
  | 'would_overpay'
  | 'amount_mismatch'

interface AssignReconciliationMatchRpcResult {
  success: boolean
  error_code: AssignMatchErrorCode | null
  error_message: string | null
}

/**
 * Single call site for the `assign_reconciliation_match` RPC — the one
 * implementation of "attach this bank transaction to this bill" that both
 * confirmReconciliationMatch() (Confirm button, target = the log row's own
 * proposed bill) and assignReconciliationMatch() (manual "Not the right
 * bill?" picker, target = a user-chosen bill) call. Three divergent
 * implementations of this same money operation is precisely what caused the
 * bug this file was rewritten to fix — do not reintroduce a second one.
 */
async function runAssignReconciliationMatch(
  supabase: ServiceClient,
  logId: string,
  targetBillId: string,
  userId: string
): Promise<{ success: boolean; error?: string; errorCode?: AssignMatchErrorCode }> {
  const { data, error } = await supabase.rpc('assign_reconciliation_match', {
    p_log_id: logId,
    p_target_bill_id: targetBillId,
    p_user_id: userId,
  })

  if (error) {
    console.error('assign_reconciliation_match RPC error:', error)
    return { success: false, error: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as AssignReconciliationMatchRpcResult | undefined

  if (!row?.success) {
    // row.error_message is the RPC's raw SQLERRM — for a would_overpay/
    // bill_void rejection this is literally 'BILL_OVERPAY: ...'/
    // 'BILL_VOID: ...' text straight from the exception, unlike every other
    // error path in this file which has already been through a TS layer.
    // Strip it here, at the one place it first reaches application code.
    return {
      success: false,
      error: row?.error_message ? stripPaymentErrorPrefix(row.error_message) : 'Failed to assign match',
      errorCode: row?.error_code ?? undefined,
    }
  }

  return { success: true }
}

// ============================================================
// confirmReconciliationMatch
// ============================================================
// SPRO-82 follow-up: no longer carries its own money logic. Confirming a
// proposal LINKS the bank transaction to the bill the matcher already
// proposed (logRow.bill_id) — it calls the exact same
// assign_reconciliation_match RPC as the manual "Not the right bill?" path
// (assignReconciliationMatch below), just with the target defaulted to the
// row's own proposal instead of a user-picked one. The RPC does the actual
// linking/creating, the overpay/void/spent/conflict guards, the log-row
// upsert (preserving the original match_type on a plain Confirm — spec A3),
// and the both-sides dismissal of conflicting pending_review rows — all of
// that used to be reimplemented here in a second, subtly different way.

export async function confirmReconciliationMatch(
  logId: string
): Promise<{ success: boolean; error?: string; errorCode?: AssignMatchErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  // Use server-derived userId — never trust a client-supplied value
  const userId = auth.session.userId

  try {
    const supabase = await createServiceClient()

    // Cheap pre-checks purely for a nicer message than the RPC's own —
    // the RPC re-checks status under a row lock regardless, so these are
    // UX only, never the authority.
    const { data: logRow, error: fetchError } = await supabase
      .from('finance_reconciliation_log')
      .select('id, bill_id, status')
      .eq('id', logId)
      .single()

    if (fetchError || !logRow) {
      return { success: false, error: fetchError?.message ?? 'Log row not found' }
    }

    if (logRow.status !== 'pending_review') {
      return {
        success: false,
        error: 'Only pending_review rows can be confirmed',
        errorCode: 'not_pending',
      }
    }

    if (!logRow.bill_id) {
      return {
        success: false,
        error: 'This transaction has no proposed bill to confirm.',
        errorCode: 'target_required',
      }
    }

    return await runAssignReconciliationMatch(supabase, logId, logRow.bill_id, userId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// dismissReconciliationMatch
// ============================================================

export async function dismissReconciliationMatch(
  logId: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  // Use server-derived userId — never trust a client-supplied value
  const userId = auth.session.userId

  try {
    const supabase = await createServiceClient()

    const { error } = await supabase
      .from('finance_reconciliation_log')
      .update({
        status: 'dismissed',
        applied_by: userId,
        applied_at: new Date().toISOString(),
      })
      .eq('id', logId)
      .eq('status', 'pending_review') // only dismiss pending rows

    if (error) {
      console.error('dismissReconciliationMatch error:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// getMatchCandidates
// ============================================================
// SPRO-43: lets a user look for a DIFFERENT bill to match a bank
// transaction to than the one the matcher proposed.
//
// Scoped mode (no opts.search): mirrors reconcile_non_check_debits()'s own
// tolerance — amount within $0.01, due_date within 45 days either side of
// the bank transaction date — over unpaid/open bills only.
//
// Search mode (opts.search set): ignores amount/date entirely; case-
// insensitive match on bill name or vendor name. This is the long-tail
// escape hatch for a bill the scoped window can't find.
//
// Both modes exclude: void bills, the currently-proposed bill_id (already
// shown as the suggested match), and any bill already reconciled
// (auto_applied/confirmed) against a DIFFERENT bank transaction — showing
// those here would just be relisted and rejected by assignReconciliationMatch.

const MATCH_WINDOW_DAYS = 45
const AMOUNT_TOLERANCE = 0.01
const MS_PER_DAY = 24 * 60 * 60 * 1000

type BillCandidateRow = {
  id: string
  name: string
  status: string
  due_date: string
  amount: number
  payment_ref: string | null
  vendor: { id: string; name: string } | { id: string; name: string }[] | null
}

const CANDIDATE_BILL_SELECT =
  'id, name, status, due_date, amount, payment_ref, vendor:finance_vendors(id, name)'

// Matches reconcile_non_check_debits()'s own status filter
// (20260701130000_recon_matcher_v3_keyword_gated.sql:168,233) so this list
// never misses the matcher's own primary case: an already-paid bill that
// just needs a link-only backfill (match_type='already_paid_non_check').
// 'scheduled' is dead today (removed by 20260624000000_bill_payment_model.sql)
// but included for parity with the matcher's own filter.
const CANDIDATE_BILL_STATUSES = ['unpaid', 'partial', 'scheduled', 'paid']

export async function getMatchCandidates(
  logId: string,
  opts?: { search?: string }
): Promise<{ success: boolean; data?: MatchCandidate[]; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data: logRow, error: fetchError } = await supabase
      .from('finance_reconciliation_log')
      .select('id, bill_id, bank_bs_id, bank_amount, bank_date')
      .eq('id', logId)
      .single()

    if (fetchError || !logRow) {
      return { success: false, error: fetchError?.message ?? 'Log row not found' }
    }

    // BUG-1 fix (SPRO-43 live-testing round): if this bank transaction is
    // already reconciled (auto_applied or confirmed) against a bill, no
    // NEW reassignment is possible — assign_reconciliation_match()'s
    // `bank_txn_spent` guard would reject any DIFFERENT target. Say so up
    // front rather than offering a list of doomed actions.
    //
    // Round-2 refinement: the RPC deliberately still allows re-assigning to
    // the SAME already-confirmed bill (a repair path for a confirmed-row-
    // but-unpaid-bill state — bank_txn_spent only fires when the target
    // bill differs from the spent row's bill). Only bail out here when a
    // spent row's bill is genuinely settled (status='paid'); an anomalous
    // confirmed-but-unpaid bill leaves that repair path reachable from the UI.
    const { data: spentRows, error: spentError } = await supabase
      .from('finance_reconciliation_log')
      .select('id, bill:finance_bills(status)')
      .eq('bank_bs_id', logRow.bank_bs_id)
      .in('status', ['auto_applied', 'confirmed'])
      .not('bill_id', 'is', null)

    if (spentError) {
      console.error('getMatchCandidates spent-check error:', spentError)
      return { success: false, error: spentError.message }
    }

    const isTrulySpent = (spentRows ?? []).some((r) => {
      const billData = r.bill as { status: string } | { status: string }[] | null
      const billStatus = Array.isArray(billData) ? billData[0]?.status : billData?.status
      return billStatus === 'paid'
    })

    if (isTrulySpent) {
      return {
        success: false,
        error: 'This bank transaction is already reconciled against a bill — no further reassignment is possible.',
      }
    }

    const bankAmount = Math.abs(logRow.bank_amount ?? 0)
    const bankDateStr = logRow.bank_date ?? new Date().toISOString().substring(0, 10)
    const bankDate = new Date(`${bankDateStr}T00:00:00Z`)

    const search = opts?.search?.trim()

    let rows: BillCandidateRow[] = []

    if (search) {
      // ---- Search mode: name OR vendor name, case-insensitive, no amount/date window ----
      // Two separate parameterized queries + in-memory merge, rather than a
      // single .or() with interpolated user input — PostgREST filter strings
      // are not safely escapable that way (a comma or a crafted
      // "zz,id.not.is.null" in the search term would either break the query
      // or silently widen it to every non-void bill; createServiceClient()
      // bypasses RLS so that's a real information-disclosure risk, not just
      // a bad UX one).
      const term = `%${search}%`

      let nameQuery = supabase
        .from('finance_bills')
        .select(CANDIDATE_BILL_SELECT)
        .neq('status', 'void')
        .ilike('name', term)

      if (logRow.bill_id) nameQuery = nameQuery.neq('id', logRow.bill_id)

      const [{ data: byName, error: byNameError }, { data: vendorMatches, error: vendorError }] =
        await Promise.all([
          nameQuery.order('due_date', { ascending: false }).limit(25),
          supabase.from('finance_vendors').select('id').ilike('name', term),
        ])

      if (byNameError) {
        console.error('getMatchCandidates name-search error:', byNameError)
        return { success: false, error: byNameError.message }
      }
      if (vendorError) {
        console.error('getMatchCandidates vendor-search error:', vendorError)
        return { success: false, error: vendorError.message }
      }

      const vendorIds = (vendorMatches ?? []).map((v) => v.id)
      let byVendor: BillCandidateRow[] = []

      if (vendorIds.length > 0) {
        let vendorBillQuery = supabase
          .from('finance_bills')
          .select(CANDIDATE_BILL_SELECT)
          .neq('status', 'void')
          .in('vendor_id', vendorIds)

        if (logRow.bill_id) vendorBillQuery = vendorBillQuery.neq('id', logRow.bill_id)

        const { data, error } = await vendorBillQuery.order('due_date', { ascending: false }).limit(25)

        if (error) {
          console.error('getMatchCandidates vendor-bill-search error:', error)
          return { success: false, error: error.message }
        }
        byVendor = data ?? []
      }

      const merged = new Map<string, BillCandidateRow>()
      for (const r of [...(byName ?? []), ...byVendor]) merged.set(r.id, r)
      rows = Array.from(merged.values())
    } else {
      // ---- Scoped mode: amount + date window ----
      const minDate = new Date(bankDate.getTime() - MATCH_WINDOW_DAYS * MS_PER_DAY)
        .toISOString()
        .substring(0, 10)
      const maxDate = new Date(bankDate.getTime() + MATCH_WINDOW_DAYS * MS_PER_DAY)
        .toISOString()
        .substring(0, 10)

      let query = supabase
        .from('finance_bills')
        .select(CANDIDATE_BILL_SELECT)
        .in('status', CANDIDATE_BILL_STATUSES)
        .gte('amount', bankAmount - AMOUNT_TOLERANCE)
        .lte('amount', bankAmount + AMOUNT_TOLERANCE)
        .gte('due_date', minDate)
        .lte('due_date', maxDate)

      if (logRow.bill_id) query = query.neq('id', logRow.bill_id)

      const { data, error } = await query.limit(100)

      if (error) {
        console.error('getMatchCandidates scoped error:', error)
        return { success: false, error: error.message }
      }

      rows = data ?? []
    }

    // Bills already reconciled (auto_applied/confirmed) against a DIFFERENT
    // bank transaction than this one — never offer these as candidates.
    // Bounded to the candidate ids we actually fetched (never unbounded —
    // PostgREST silently caps results at 1000 rows with no error, which
    // would have quietly produced an incomplete exclusion set on a large
    // table) and computed AFTER fetching candidates, so the exclusion never
    // eats into the row limit before we know which rows need it.
    const candidateIds = rows.map((r) => r.id)
    const excludedBillIds = new Set<string>()

    if (candidateIds.length > 0) {
      const { data: reconciledElsewhere, error: reconciledError } = await supabase
        .from('finance_reconciliation_log')
        .select('bill_id')
        .in('bill_id', candidateIds)
        .in('status', ['auto_applied', 'confirmed'])
        .neq('bank_bs_id', logRow.bank_bs_id)

      if (reconciledError) {
        console.error('getMatchCandidates reconciled-elsewhere error:', reconciledError)
        return { success: false, error: reconciledError.message }
      }

      for (const r of reconciledElsewhere ?? []) {
        if (r.bill_id) excludedBillIds.add(r.bill_id)
      }
    }

    const candidates: MatchCandidate[] = rows
      .filter((r) => !excludedBillIds.has(r.id))
      .map((r) => {
        const vendorData = r.vendor as { id: string; name: string } | { id: string; name: string }[] | null
        const vendorName = Array.isArray(vendorData) ? (vendorData[0]?.name ?? null) : (vendorData?.name ?? null)
        const dueDate = new Date(`${r.due_date}T00:00:00Z`)
        const daysFromTxn = Math.round((dueDate.getTime() - bankDate.getTime()) / MS_PER_DAY)
        return {
          id: r.id,
          name: r.name,
          vendor_name: vendorName,
          status: r.status as MatchCandidate['status'],
          due_date: r.due_date,
          amount: Number(r.amount),
          payment_ref: r.payment_ref,
          amount_matches: Math.abs(Number(r.amount) - bankAmount) <= AMOUNT_TOLERANCE,
          days_from_txn: daysFromTxn,
        }
      })

    if (!search) {
      candidates.sort((a, b) => Math.abs(a.days_from_txn) - Math.abs(b.days_from_txn))
    }

    return { success: true, data: candidates.slice(0, 25) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// assignReconciliationMatch
// ============================================================
// SPRO-43 (post-review): thin wrapper around the assign_reconciliation_match
// RPC (supabase/migrations/20260806220000_recon_link_payments.sql). The
// original implementation applied the bill payment and recorded the log row
// in two separate statements — if the second failed, the bill was left paid
// with no record of why, and a retry against a different bill could pay it
// too. The RPC does everything in one Postgres transaction with row-level
// locks (SELECT ... FOR UPDATE) on both the log row and the target bill, so
// it's impossible to observe a partially-applied result, and concurrent
// calls (double-submit, or two different suggestions both targeting the
// same bill) serialize instead of racing.
//
// The RPC call itself, the error_code union, and the error-shape parsing all
// live in runAssignReconciliationMatch() above — shared with
// confirmReconciliationMatch() so there is exactly one implementation of
// "attach this bank transaction to this bill".

export async function assignReconciliationMatch(
  logId: string,
  targetBillId: string
): Promise<{ success: boolean; error?: string; errorCode?: AssignMatchErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  // Use server-derived userId — never trust a client-supplied value
  const userId = auth.session.userId

  if (!targetBillId) {
    return { success: false, error: 'A target bill is required' }
  }

  try {
    const supabase = await createServiceClient()
    return await runAssignReconciliationMatch(supabase, logId, targetBillId, userId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// runDailyReconciliation
// ============================================================
// Orchestrates check reconciliation then non-check proposals.
// Returns counts for both legs.

export interface DailyReconciliationResult {
  check_auto_applied: number
  check_mismatch: number
  noncheck_proposed: number
}

export async function runDailyReconciliation(): Promise<{
  success: boolean
  data?: DailyReconciliationResult
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase.rpc('run_daily_reconciliation')

    if (error) {
      console.error('runDailyReconciliation error:', error)
      return { success: false, error: error.message }
    }

    const row = Array.isArray(data) ? data[0] : data
    return { success: true, data: row as DailyReconciliationResult }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// runNonCheckReconciliation
// ============================================================
// Proposes non-check debit matches only.

export interface NonCheckReconciliationResult {
  scanned_count: number
  proposed_count: number
  skipped_count: number
}

export async function runNonCheckReconciliation(): Promise<{
  success: boolean
  data?: NonCheckReconciliationResult
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase.rpc('reconcile_non_check_debits')

    if (error) {
      console.error('runNonCheckReconciliation error:', error)
      return { success: false, error: error.message }
    }

    const row = Array.isArray(data) ? data[0] : data
    return { success: true, data: row as NonCheckReconciliationResult }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// getProposedTransactions
// ============================================================
// Returns pending_review rows from finance_reconciliation_log joined
// to finance_bills(name), scoped to a calendar month by bank_date.
// Does NOT call get_bank_transactions — reads log rows directly.

export interface ProposedTransaction {
  log_id: string
  bank_bs_id: number
  bill_id: string | null
  bill_name: string | null
  match_type: ReconMatchType
  bank_amount: number | null
  bank_date: string | null
  bank_description: string | null
  suggested_payment_method: string | null
}

export async function getProposedTransactions(month: string): Promise<{
  success: boolean
  data?: ProposedTransaction[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Scope to the given month by YYYY-MM prefix on bank_date
    const monthStart = month                               // 'YYYY-MM-01'
    const [year, mon] = month.split('-').map(Number)
    const endDate = new Date(year, mon, 1)                 // first day of next month
    const monthEnd = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`

    const { data, error } = await supabase
      .from('finance_reconciliation_log')
      .select(`
        id,
        bank_bs_id,
        bill_id,
        match_type,
        bank_amount,
        bank_date,
        bank_description,
        suggested_payment_method,
        bill:finance_bills(name)
      `)
      .eq('status', 'pending_review')
      .gte('bank_date', monthStart)
      .lt('bank_date', monthEnd)
      .order('bank_date', { ascending: false })

    if (error) {
      console.error('getProposedTransactions error:', error)
      return { success: false, error: error.message }
    }

    const rows: ProposedTransaction[] = (data ?? []).map((r) => {
      const billData = r.bill as { name: string } | { name: string }[] | null
      const billName = Array.isArray(billData) ? (billData[0]?.name ?? null) : (billData?.name ?? null)
      return {
        log_id: r.id,
        bank_bs_id: r.bank_bs_id,
        bill_id: r.bill_id,
        bill_name: billName,
        match_type: r.match_type as ReconMatchType,
        bank_amount: r.bank_amount,
        bank_date: r.bank_date,
        bank_description: r.bank_description,
        suggested_payment_method: r.suggested_payment_method ?? null,
      }
    })

    return { success: true, data: rows }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// getUnreconciledPayments
// ============================================================
// SPRO-82: the visible answer to the ticket's first sentence — a payment
// recorded manually (source='manual', e.g. "Payroll - Josh $1,000 partial")
// sits here with bank_bs_id IS NULL until a bank transaction is matched to
// it via confirmReconciliationMatch()/assignReconciliationMatch(). Scoped to
// a calendar month by paid_date, same convention as getProposedTransactions().

export interface UnreconciledPayment {
  id: string
  bill_id: string
  bill_name: string
  vendor_name: string | null
  amount: number
  paid_date: string
  payment_method: string
  payment_ref: string | null
  source: 'manual' | 'bank_auto' | 'bank_manual'
  notes: string | null
}

export async function getUnreconciledPayments(month: string): Promise<{
  success: boolean
  data?: UnreconciledPayment[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Scope to the given month by YYYY-MM prefix on paid_date, same pattern
    // as getProposedTransactions()'s bank_date scoping above.
    const monthStart = month // 'YYYY-MM-01'
    const [year, mon] = month.split('-').map(Number)
    const endDate = new Date(year, mon, 1) // first day of next month
    const monthEnd = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`

    const { data, error } = await supabase
      .from('finance_bill_payments')
      .select(`
        id, bill_id, amount, paid_date, payment_method, payment_ref, source, notes,
        bill:finance_bills(name, vendor:finance_vendors(name))
      `)
      .is('bank_bs_id', null)
      .gte('paid_date', monthStart)
      .lt('paid_date', monthEnd)
      .order('paid_date', { ascending: false })

    if (error) {
      console.error('getUnreconciledPayments error:', error)
      return { success: false, error: error.message }
    }

    type BillJoin = { name: string; vendor: { name: string } | { name: string }[] | null }

    const rows: UnreconciledPayment[] = (data ?? []).map((r) => {
      const billData = r.bill as BillJoin | BillJoin[] | null
      const bill = Array.isArray(billData) ? billData[0] : billData
      const vendorData = bill?.vendor ?? null
      const vendorName = Array.isArray(vendorData) ? (vendorData[0]?.name ?? null) : (vendorData?.name ?? null)
      return {
        id: r.id,
        bill_id: r.bill_id,
        bill_name: bill?.name ?? 'Unknown bill',
        vendor_name: vendorName,
        amount: Number(r.amount),
        paid_date: r.paid_date,
        payment_method: r.payment_method,
        payment_ref: r.payment_ref,
        source: r.source as UnreconciledPayment['source'],
        notes: r.notes,
      }
    })

    return { success: true, data: rows }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// getUntrackedBankTransactions
// ============================================================
// Calls the service-role-only RPC, then filters to the given month.
// `month` is the same YYYY-MM-01 string used by getMonthSummary (e.g. '2026-06-01').

export async function getUntrackedBankTransactions(month: string): Promise<{
  success: boolean
  data?: BankTransaction[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()
    const { data, error } = await supabase.rpc('get_untracked_bank_transactions')

    if (error) {
      console.error('getUntrackedBankTransactions error:', error)
      return { success: false, error: error.message }
    }

    // Filter to only transactions whose txn_date falls within the selected month.
    // Both month and txn_date are ISO date strings; compare YYYY-MM prefixes.
    const monthPrefix = month.substring(0, 7) // 'YYYY-MM'
    const filtered = ((data ?? []) as BankTransaction[]).filter(
      (txn) => txn.txn_date.substring(0, 7) === monthPrefix
    )

    return { success: true, data: filtered }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// Shared building blocks for the untracked-transaction flows
// ============================================================
// createBillFromBankTransaction() and linkBillToBankTransaction() differ only
// in whether the target bill is created first. Everything else — the
// bank_txn_spent pre-flight, reading the bank side of the audit trail, and the
// seed-then-assign dance around assign_reconciliation_match() — is shared so
// the two can never drift into having different guarantees.

/**
 * Refuses early if this bank transaction has already been reconciled
 * (auto_applied or confirmed) against ANY bill. Mirrors
 * get_untracked_bank_transactions()'s own definition of "untracked" and the
 * RPC's `bank_txn_spent` guard. Running it BEFORE creating anything means a
 * stale page can't leave an orphan bill behind.
 */
async function isBankTransactionSpent(
  supabase: ServiceClient,
  bsId: number
): Promise<{ spent: boolean; error?: string }> {
  const { data, error } = await supabase
    .from('finance_reconciliation_log')
    .select('id')
    .eq('bank_bs_id', bsId)
    .in('status', ['auto_applied', 'confirmed'])
    .limit(1)

  if (error) {
    console.error('isBankTransactionSpent error:', error)
    return { spent: false, error: error.message }
  }
  return { spent: (data?.length ?? 0) > 0 }
}

/**
 * Reads one still-untracked transaction's own figures from banksync. The seed
 * log row is an audit record of what the BANK said, so amount / date /
 * description must come from here and never from the client (the user can edit
 * the amount in the sheet, and that edit must not rewrite the bank side of the
 * audit trail).
 */
async function readUntrackedBankTransaction(
  supabase: ServiceClient,
  bsId: number
): Promise<{ txn?: BankTransaction; error?: string }> {
  const { data, error } = await supabase.rpc('get_untracked_bank_transactions')

  if (error) {
    console.error('readUntrackedBankTransaction error:', error)
    return { error: error.message }
  }

  const txn = ((data ?? []) as BankTransaction[]).find((t) => Number(t.bs_id) === Number(bsId))

  if (!txn) {
    return {
      error: 'That bank transaction is no longer untracked. Refresh the finance page and try again.',
    }
  }
  return { txn }
}

// ---- Duplicate detection ------------------------------------------------
// Deliberately amount + date ONLY. reconcile_non_check_debits() additionally
// requires a vendor keyword from the bill/vendor name to appear in the bank
// description; that gating is exactly why bs_id 1083 ($22,815, "TRANSFER FROM
// X5514 TO X1210 JTS POS BILL JULY") shows as untracked despite its paid
// "PSO - large" bill — the bank's "POS BILL" typo defeats the "PSO BILL"
// keyword. Replicating the matcher's gating here would rebuild the blind spot
// this check exists to cover. It is intentionally loose and advisory: a human
// decides, and createBillFromBankTransaction() only requires them to say so.
//
// EXCLUSION (post-measurement fix): a candidate already reconciled
// (auto_applied/confirmed) against a DIFFERENT bank transaction is never a
// real duplicate of THIS one — it's the recurring-bill case. Rent is
// $5,000/month; June's bill is already linked to June's debit, so July's
// untracked debit would otherwise pull June's bill into the amount+date
// window and tell the user to "match to it instead" of creating July's bill,
// which is exactly the wrong advice. Same exclusion getMatchCandidates() uses
// (see its comment block above, ~line 491) and for the identical reason —
// mirrored here rather than reimplemented differently so the two paths can't
// silently diverge on what counts as "already spoken for". Measured against
// production (read-only): this exclusion drops the candidate set from 73
// pairs / 38 transactions-with-a-banner to 14 pairs / 11 transactions.

/** Cap on rows pulled before ranking. The amount window makes >100 unrealistic. */
const DUPLICATE_SCAN_LIMIT = 100

type DuplicateBillRow = {
  id: string
  name: string
  amount: number
  due_date: string
  status: string
  payment_ref: string | null
  vendor: { name: string } | { name: string }[] | null
}

async function findDuplicateBillCandidates(
  supabase: ServiceClient,
  bsId: number,
  txn: Pick<BankTransaction, 'amount' | 'txn_date'>
): Promise<{ data?: DuplicateBillCandidate[]; error?: string }> {
  const window = duplicateDateWindow(txn.txn_date)

  if (!window) {
    // Unreachable with real data (txn_date is a DATE column) but must not be
    // swallowed: silently skipping the check is how a duplicate gets created.
    return {
      error: `Could not read the bank transaction date ("${txn.txn_date}"), so existing bills could not be checked for a duplicate.`,
    }
  }

  const bankAmount = Math.abs(Number(txn.amount))

  const { data, error } = await supabase
    .from('finance_bills')
    .select('id, name, amount, due_date, status, payment_ref, vendor:finance_vendors(name)')
    .neq('status', 'void')
    .gte('amount', bankAmount - DUPLICATE_AMOUNT_TOLERANCE)
    .lte('amount', bankAmount + DUPLICATE_AMOUNT_TOLERANCE)
    .gte('due_date', window.minDate)
    .lte('due_date', window.maxDate)
    .order('due_date', { ascending: false })
    .limit(DUPLICATE_SCAN_LIMIT)

  if (error) {
    console.error('findDuplicateBillCandidates error:', error)
    return { error: error.message }
  }

  const rows = (data ?? []) as DuplicateBillRow[]

  // Bills already reconciled (auto_applied/confirmed) against a DIFFERENT bank
  // transaction than this one — never real duplicates of THIS transaction. See
  // EXCLUSION comment above. Bounded to the candidate ids just fetched (never
  // unbounded — PostgREST silently caps at 1000 rows with no error, mirroring
  // getMatchCandidates()'s own reasoning) and computed AFTER fetching
  // candidates so the exclusion query never competes with DUPLICATE_SCAN_LIMIT.
  const candidateIds = rows.map((r) => r.id)
  const excludedBillIds = new Set<string>()

  if (candidateIds.length > 0) {
    const { data: reconciledElsewhere, error: reconciledError } = await supabase
      .from('finance_reconciliation_log')
      .select('bill_id')
      .in('bill_id', candidateIds)
      .in('status', ['auto_applied', 'confirmed'])
      .neq('bank_bs_id', bsId)

    if (reconciledError) {
      console.error('findDuplicateBillCandidates reconciled-elsewhere error:', reconciledError)
      return { error: reconciledError.message }
    }

    for (const r of reconciledElsewhere ?? []) {
      if (r.bill_id) excludedBillIds.add(r.bill_id)
    }
  }

  const candidates: DuplicateBillCandidate[] = excludeReconciledElsewhere(rows, excludedBillIds).map((r) => {
    const vendorData = r.vendor
    const vendorName = Array.isArray(vendorData) ? (vendorData[0]?.name ?? null) : (vendorData?.name ?? null)
    return {
      id: r.id,
      name: r.name,
      vendor_name: vendorName,
      amount: Number(r.amount),
      due_date: r.due_date,
      status: r.status,
      payment_ref: r.payment_ref,
    }
  })

  return { data: rankDuplicateCandidates(candidates, txn.txn_date) }
}

// ---- Seed + assign ------------------------------------------------------

interface SeedAndAssignInput {
  bsId: number
  billId: string
  /** finance_bills.amount for the audit row's bill_amount column. */
  billAmount: number
  /**
   * The payment method that should end up on the AUDIT row. 'check' is seeded
   * as 'ach' and restored after the assign — see below.
   */
  auditPaymentMethod: string | null | undefined
  txn: BankTransaction
}

/**
 * Pairs a bank transaction with a bill through assign_reconciliation_match().
 *
 * That RPC takes an EXISTING finance_reconciliation_log row and requires
 * status='pending_review'; an untracked transaction may have no row for this
 * pair at all. So we seed one (or revive an existing non-applied one) and run
 * the RPC on it. Every cross-bill guard inside the RPC (bank_txn_spent,
 * already_reconciled, auto_applied_conflict) plus pg_advisory_xact_lock
 * (bank_bs_id) still executes — none of them is bypassed.
 *
 * Why the pair may already have a row: get_untracked_bank_transactions()
 * excludes only auto_applied/confirmed rows, so a transaction with a
 * *pending_review* proposal (or a previously *dismissed* one) still shows as
 * untracked. A blind INSERT would then hit uq_reconciliation_bank_bill and
 * fail with a unique violation on exactly the bill the user picked. The
 * caller's spent pre-flight guarantees any row we find here is pending_review
 * or dismissed, never auto_applied/confirmed, and the UPDATE is status-guarded
 * to that set anyway.
 *
 * On failure the seed is undone (deleted if we inserted it, restored to its
 * prior values if we revived one) so a rejected attempt can never leave a
 * phantom proposal behind. Both undo paths are guarded on the row still being
 * pending_review, so we never clobber a row another process has moved on.
 */
async function seedAndAssignReconciliation(
  supabase: ServiceClient,
  { bsId, billId, billAmount, auditPaymentMethod, txn }: SeedAndAssignInput
): Promise<{ success: boolean; error?: string; errorCode?: AssignMatchErrorCode }> {
  // assign_reconciliation_match() hard-rejects suggested_payment_method='check'
  // with error_code='check_requires_ref' — a defensive guard for a path that
  // has no payment_ref to work with. Seed a non-check method to get past it and
  // restore the real one on the audit row once the assign succeeds. Without the
  // restore, a finance audit row would permanently claim 'ach' for a check.
  // The RPC itself is not modified.
  const trueMethod = normalizePaymentMethod(auditPaymentMethod)
  const seedMethod = trueMethod === 'check' ? 'ach' : trueMethod

  const seedFields = {
    match_type: 'manual_override',
    // Raw signed banksync amount (outflows are negative), same convention as
    // reconcile_non_check_debits(). The RPC does ABS() on it.
    bank_amount: txn.amount,
    bill_amount: billAmount,
    bank_date: txn.txn_date,
    bank_description: txn.description,
    status: 'pending_review',
    suggested_payment_method: seedMethod,
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('finance_reconciliation_log')
    .select('id, status, match_type, bank_amount, bill_amount, bank_date, bank_description, suggested_payment_method')
    .eq('bank_bs_id', bsId)
    .eq('bill_id', billId)
    .limit(1)

  if (existingError) {
    console.error('seedAndAssignReconciliation existing-row lookup error:', existingError)
    return { success: false, error: existingError.message }
  }

  const existing = existingRows?.[0] ?? null

  let logId: string
  let undoSeed: () => Promise<void>

  if (existing) {
    const { error: reviveError } = await supabase
      .from('finance_reconciliation_log')
      .update(seedFields)
      .eq('id', existing.id)
      // Never touch a row that is (or became) auto_applied/confirmed. If this
      // matches nothing, the RPC below rejects with not_pending /
      // auto_applied_conflict and the undo is a no-op — safe either way.
      .in('status', ['pending_review', 'dismissed'])

    if (reviveError) {
      console.error('seedAndAssignReconciliation revive error:', reviveError)
      return { success: false, error: reviveError.message }
    }

    logId = existing.id
    undoSeed = async () => {
      const { error: restoreError } = await supabase
        .from('finance_reconciliation_log')
        .update({
          match_type: existing.match_type,
          bank_amount: existing.bank_amount,
          bill_amount: existing.bill_amount,
          bank_date: existing.bank_date,
          bank_description: existing.bank_description,
          status: existing.status,
          suggested_payment_method: existing.suggested_payment_method,
        })
        .eq('id', existing.id)
        .eq('status', 'pending_review')

      if (restoreError) {
        console.error('seedAndAssignReconciliation seed-restore error:', restoreError)
      }
    }
  } else {
    const { data: seedRow, error: seedError } = await supabase
      .from('finance_reconciliation_log')
      .insert({ bank_bs_id: bsId, bill_id: billId, ...seedFields })
      .select('id')
      .single()

    if (seedError || !seedRow) {
      console.error('seedAndAssignReconciliation seed error:', seedError)
      return { success: false, error: seedError?.message ?? 'could not record the link' }
    }

    logId = seedRow.id
    undoSeed = async () => {
      const { error: cleanupError } = await supabase
        .from('finance_reconciliation_log')
        .delete()
        .eq('id', logId)
        .eq('status', 'pending_review')

      if (cleanupError) {
        console.error('seedAndAssignReconciliation seed-cleanup error:', cleanupError)
      }
    }
  }

  const assignResult = await assignReconciliationMatch(logId, billId)

  if (!assignResult.success) {
    await undoSeed()
    return {
      success: false,
      error: assignResult.error ?? 'unknown error',
      errorCode: assignResult.errorCode,
    }
  }

  // Restore the real payment method on the audit row. Non-fatal: the money is
  // already applied; this only corrects the row's descriptive field.
  if (trueMethod !== seedMethod) {
    const { error: methodError } = await supabase
      .from('finance_reconciliation_log')
      .update({ suggested_payment_method: trueMethod })
      .eq('id', logId)

    if (methodError) {
      console.error('seedAndAssignReconciliation method-restore error:', methodError)
    }
  }

  return { success: true }
}

// ============================================================
// getDuplicateBillCandidates
// ============================================================
// SPRO-77 (live testing): advisory check behind the "a bill for this amount
// already exists" warning on the Create Bill sheet. See
// findDuplicateBillCandidates() above for why this ignores vendor keywords.

export async function getDuplicateBillCandidates(bsId: number): Promise<{
  success: boolean
  data?: DuplicateBillCandidate[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!Number.isFinite(bsId)) {
    return { success: false, error: 'A bank transaction is required' }
  }

  try {
    const supabase = await createServiceClient()

    const { txn, error: txnError } = await readUntrackedBankTransaction(supabase, bsId)
    if (!txn) return { success: false, error: txnError }

    const { data, error } = await findDuplicateBillCandidates(supabase, bsId, txn)
    if (error) return { success: false, error }

    return { success: true, data: data ?? [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// linkBillToBankTransaction
// ============================================================
// SPRO-77 (live testing): "Match to this bill instead" on the duplicate
// warning. Same guarded path as createBillFromBankTransaction() with the
// create step removed — the bill already exists.
//
// The target bill may already be paid or partial — SPRO-82's
// assign_reconciliation_match() (spec A5) no longer special-cases that: it
// always upserts a finance_bill_payments row at the bank figures, and the
// recompute trigger derives finance_bills' status/amount_paid/paid_date/
// payment_method from the ledger. That is correct and is exactly what the
// existing manual-match UI (getMatchCandidates → assignReconciliationMatch)
// already does.

export async function linkBillToBankTransaction(input: {
  bsId: number
  billId: string
}): Promise<{ success: boolean; error?: string; errorCode?: AssignMatchErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  const { bsId, billId } = input

  if (!Number.isFinite(bsId)) {
    return { success: false, error: 'A bank transaction is required' }
  }
  if (!billId) {
    return { success: false, error: 'A target bill is required' }
  }

  try {
    const supabase = await createServiceClient()

    // ---- 1. Pre-flight: is this transaction still unspent? ----------------
    const { spent, error: spentError } = await isBankTransactionSpent(supabase, bsId)
    if (spentError) return { success: false, error: spentError }
    if (spent) {
      return {
        success: false,
        error:
          'This bank transaction has already been reconciled against another bill. Refresh the finance page.',
        errorCode: 'bank_txn_spent',
      }
    }

    // ---- 2. Read the bank transaction's own figures ------------------------
    const { txn, error: txnError } = await readUntrackedBankTransaction(supabase, bsId)
    if (!txn) return { success: false, error: txnError }

    // ---- 3. Read the target bill ------------------------------------------
    // Needed for the audit row's bill_amount. The void/missing checks are
    // duplicated inside the RPC (which is the authority, under a row lock);
    // doing them here only buys a clearer message before anything is written.
    const { data: bill, error: billError } = await supabase
      .from('finance_bills')
      .select('id, amount, status')
      .eq('id', billId)
      .single()

    if (billError || !bill) {
      return { success: false, error: billError?.message ?? 'Bill not found', errorCode: 'bill_not_found' }
    }
    if (bill.status === 'void') {
      return {
        success: false,
        error: 'Cannot match a bank transaction to a voided bill',
        errorCode: 'bill_void',
      }
    }

    // ---- 4. Seed + assign --------------------------------------------------
    // suggested_payment_method describes what the BANK says, so it comes from
    // the description, exactly as reconcile_non_check_debits() derives its own.
    const { payment_method } = derivePrefillPayment(txn.description)

    return await seedAndAssignReconciliation(supabase, {
      bsId,
      billId,
      billAmount: Number(bill.amount),
      auditPaymentMethod: payment_method,
      txn,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('linkBillToBankTransaction error:', err)
    return { success: false, error: msg }
  }
}

// ============================================================
// createBillFromBankTransaction
// ============================================================
// SPRO-77: "Create Bill" on an untracked bank expense. Creates the bill AND
// links it to the bank transaction so the transaction stops showing as
// untracked.
//
// The link itself goes through seedAndAssignReconciliation() — see there for
// why assign_reconciliation_match() can't just be called directly and why
// every guard inside it still executes. Nothing is bypassed.
//
// Failure model, in order of what the user cares about:
//   - already reconciled elsewhere  -> nothing is created at all
//   - a bill for this money already exists (and the user hasn't said "create it
//     anyway") -> nothing is created at all, candidates returned
//   - bill created, link failed     -> KEEP the bill (it's the user's data),
//                                      delete the seed row so it can't render
//                                      as a phantom proposal, warn the user
//   - both succeeded                -> reconciled

export interface CreateBillFromBankTransactionResult {
  success: boolean
  billCreated: boolean
  reconciled: boolean
  error?: string
  warning?: string
  /**
   * Set only when the duplicate guard refused. Present ⇒ nothing was created.
   * Re-submit with allowDuplicate:true to create the bill anyway.
   */
  duplicates?: DuplicateBillCandidate[]
}

export async function createBillFromBankTransaction(input: {
  bsId: number
  /**
   * The user has seen the existing bills for this amount and still wants a new
   * one. Two identical bills in a month is legitimate, so this is a
   * confirmation, not a block — but it must be an explicit one: a client that
   * never sets this flag cannot create a duplicate by accident.
   */
  allowDuplicate?: boolean
  bill: {
    name: string
    amount: number
    due_date: string
    status: BillStatus
    payment_method?: string | null
    payment_ref?: string | null
    paid_date?: string | null
    amount_paid?: number | null
    notes?: string | null
    vendor_id?: string
  }
}): Promise<CreateBillFromBankTransactionResult> {
  const auth = await requireFinance()
  if (!auth.authorized) {
    return { success: false, billCreated: false, reconciled: false, error: auth.reason }
  }

  // FIX 5 (SPRO-82 adversarial review): no longer need a locally-derived
  // userId here — createBill() below derives created_by from its own
  // requireFinance() session, and seedAndAssignReconciliation() /
  // assignReconciliationMatch() derive applied_by from theirs. auth.authorized
  // above is still the actual gate.

  const { bsId, bill, allowDuplicate } = input

  if (!Number.isFinite(bsId)) {
    return {
      success: false,
      billCreated: false,
      reconciled: false,
      error: 'A bank transaction is required',
    }
  }

  // Tracked outside the try so the catch below can tell the caller whether a
  // bill actually landed — reporting billCreated:false after a successful
  // insert would invite the user to save again and create a duplicate.
  let billCreated = false

  try {
    const supabase = await createServiceClient()

    // ---- 1. Pre-flight: is this transaction still untracked? -------------
    const { spent, error: spentError } = await isBankTransactionSpent(supabase, bsId)

    if (spentError) {
      return { success: false, billCreated: false, reconciled: false, error: spentError }
    }
    if (spent) {
      return {
        success: false,
        billCreated: false,
        reconciled: false,
        error:
          'This bank transaction has already been reconciled against another bill. Refresh the finance page.',
      }
    }

    // ---- 2. Read the bank transaction's own figures ----------------------
    const { txn, error: txnError } = await readUntrackedBankTransaction(supabase, bsId)

    if (!txn) {
      return { success: false, billCreated: false, reconciled: false, error: txnError }
    }

    // ---- 3. Duplicate guard ----------------------------------------------
    // The matcher's vendor-keyword gating means an untracked transaction can
    // already have a bill on record (bs_id 1083 / "PSO - large", $22,815).
    // Creating one here would silently double the liability. Refuse unless the
    // caller has explicitly said "create it anyway" — the client's flag is a
    // convenience, this is the actual gate. Fails CLOSED: if the check itself
    // errors we refuse rather than create a possible duplicate.
    if (!allowDuplicate) {
      const { data: duplicates, error: duplicateError } = await findDuplicateBillCandidates(
        supabase,
        bsId,
        txn
      )

      if (duplicateError) {
        return { success: false, billCreated: false, reconciled: false, error: duplicateError }
      }

      if (duplicates && duplicates.length > 0) {
        return {
          success: false,
          billCreated: false,
          reconciled: false,
          duplicates,
          error:
            duplicates.length === 1
              ? `A bill for this amount already exists ("${duplicates[0].name}"). Match the bank transaction to it, or confirm you want a second bill.`
              : `${duplicates.length} bills for this amount already exist. Match the bank transaction to one, or confirm you want another bill.`,
        }
      }
    }

    // ---- 4. Create the bill ---------------------------------------------
    const billResult = await createBill({
      name: bill.name,
      vendor_id: bill.vendor_id || undefined,
      amount: bill.amount,
      due_date: bill.due_date,
      status: bill.status,
      payment_method: bill.payment_method ?? undefined,
      payment_ref: bill.payment_ref ?? undefined,
      paid_date: bill.paid_date ?? undefined,
      amount_paid: bill.amount_paid ?? undefined,
      notes: bill.notes ?? undefined,
      // FIX 5 (SPRO-82 adversarial review): createBill() no longer accepts
      // created_by from its caller — it derives it server-side from its own
      // requireFinance() session.
    })

    if (!billResult.success || !billResult.data) {
      return {
        success: false,
        billCreated: false,
        reconciled: false,
        error: billResult.error ?? 'Failed to create bill',
      }
    }

    const newBill = billResult.data
    billCreated = true

    // ---- 5. Seed the log row and apply the match atomically ---------------
    // The bill is brand new, so seedAndAssignReconciliation() always takes its
    // insert path here — the (bank_bs_id, bill_id) pair cannot already exist.
    const linkResult = await seedAndAssignReconciliation(supabase, {
      bsId,
      billId: newBill.id,
      billAmount: newBill.amount,
      // The user's own choice in the sheet, which carries its own check number.
      auditPaymentMethod: bill.payment_method,
      txn,
    })

    if (!linkResult.success) {
      // Keep the bill — it's the user's data and re-entering it is worse than
      // an unlinked bill. The seed row has already been cleaned up so it can't
      // surface as a phantom "match proposed" in the reconciliation UI.
      return {
        success: true,
        billCreated: true,
        reconciled: false,
        warning: `Bill created, but it could not be linked to the bank transaction: ${
          linkResult.error ?? 'unknown error'
        }`,
      }
    }

    return { success: true, billCreated: true, reconciled: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('createBillFromBankTransaction error:', err)
    if (billCreated) {
      return {
        success: true,
        billCreated: true,
        reconciled: false,
        warning: `Bill created, but it could not be linked to the bank transaction: ${msg}`,
      }
    }
    return { success: false, billCreated: false, reconciled: false, error: msg }
  }
}
