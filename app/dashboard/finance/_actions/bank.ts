'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { requireFinance } from '@/lib/auth/session'
import { markBillPaid } from '@/actions/finance'

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
// Shared payment helpers (used by confirmReconciliationMatch AND
// assignReconciliationMatch so the "how do we apply money to a bill"
// rules are defined once).
// ============================================================

const VALID_BILL_METHODS = ['card', 'ach', 'check', 'cash'] as const

/**
 * Normalize a reconciliation-derived payment method to a value accepted by
 * finance_bills.payment_method (card | ach | check | cash). Reconciliation
 * keyword detection can yield 'transfer', 'wire', 'ach_transfer', or null —
 * none of which are valid bill payment methods. Map transfer/wire variants
 * → 'ach'; anything else not in the valid set → 'ach'.
 */
function normalizePaymentMethod(raw: string | null | undefined): string {
  const rawMethod = raw ?? ''
  return rawMethod === 'transfer' || rawMethod === 'wire' || rawMethod === 'ach_transfer'
    ? 'ach'
    : (VALID_BILL_METHODS as readonly string[]).includes(rawMethod)
      ? rawMethod
      : 'ach'
}

/**
 * Applies a bank-derived payment to a bill:
 *   - bill.status === 'paid' → backfill only missing paid_date / payment_method /
 *     amount_paid (never overwrite an existing paid bill's figures — amendments E+F).
 *   - otherwise               → markBillPaid at the bank amount/date/method.
 */
async function applyBillPayment(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  billId: string,
  bankAmount: number,
  bankDate: string,
  payMethod: string
): Promise<{ success: boolean; error?: string }> {
  const { data: bill, error: billFetchError } = await supabase
    .from('finance_bills')
    .select('status, paid_date, amount_paid, payment_method')
    .eq('id', billId)
    .single()

  if (billFetchError || !bill) {
    return { success: false, error: billFetchError?.message ?? 'Bill not found' }
  }

  if (bill.status === 'paid') {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (!bill.paid_date)                              patch.paid_date = bankDate
    if (!bill.payment_method)                         patch.payment_method = payMethod
    if (!bill.amount_paid || Number(bill.amount_paid) === 0) patch.amount_paid = bankAmount

    const { error: patchError } = await supabase
      .from('finance_bills')
      .update(patch)
      .eq('id', billId)

    if (patchError) {
      console.error('applyBillPayment backfill error:', patchError)
      return { success: false, error: patchError.message }
    }
    return { success: true }
  }

  const payResult = await markBillPaid(billId, {
    amount_paid: bankAmount,
    paid_date: bankDate,
    payment_method: payMethod,
  })

  if (!payResult.success) {
    return { success: false, error: payResult.error ?? 'Failed to mark bill paid' }
  }
  return { success: true }
}

// ============================================================
// confirmReconciliationMatch
// ============================================================
// Handles all pending_review match types via bill's CURRENT status (amendment F):
//   - bill.status === 'paid' → backfill missing paid_date / payment_method / amount_paid (amendments E+F)
//   - bill.status !== 'paid' → markBillPaid at bank amount/date/method (covers check_amount_mismatch,
//     card_amount_vendor, amount_only, already_paid_non_check when bill not yet paid)
//
// After confirming, dismisses all other pending_review rows for the same
// bank_bs_id OR bill_id (amendment D).

export async function confirmReconciliationMatch(
  logId: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  // Use server-derived userId — never trust a client-supplied value
  const userId = auth.session.userId

  try {
    const supabase = await createServiceClient()

    // Fetch the log row — include suggested_payment_method and bank_bs_id for amendments D/E/F
    const { data: logRow, error: fetchError } = await supabase
      .from('finance_reconciliation_log')
      .select('id, bill_id, match_type, bank_amount, bank_date, bank_bs_id, suggested_payment_method, status')
      .eq('id', logId)
      .single()

    if (fetchError || !logRow) {
      return { success: false, error: fetchError?.message ?? 'Log row not found' }
    }

    if (logRow.status !== 'pending_review') {
      return { success: false, error: 'Only pending_review rows can be confirmed' }
    }

    const bankAmount = Math.abs(logRow.bank_amount ?? 0)
    const bankDate   = logRow.bank_date ?? new Date().toISOString().substring(0, 10)
    const payMethod  = normalizePaymentMethod(logRow.suggested_payment_method)

    if (logRow.bill_id) {
      // BUG-1 fix (SPRO-43 live-testing round): refuse if this bank
      // transaction is already reconciled (auto_applied or confirmed)
      // against a DIFFERENT bill. Without this, one bank transaction could
      // pay multiple bills — reconcile_cleared_checks() only skips a
      // transaction that already has an auto_applied row, NOT a confirmed
      // one (20260624000000_bill_payment_model.sql:38-39), so a
      // manually-confirmed transaction can get a fresh pending_review row
      // pointing at a different bill on the next cron run. Same guard as
      // assign_reconciliation_match()'s `bank_txn_spent` check.
      const { data: spentRows, error: spentError } = await supabase
        .from('finance_reconciliation_log')
        .select('id')
        .eq('bank_bs_id', logRow.bank_bs_id)
        .in('status', ['auto_applied', 'confirmed'])
        .not('bill_id', 'is', null)
        .neq('bill_id', logRow.bill_id)
        .limit(1)

      if (spentError) {
        console.error('confirmReconciliationMatch spent-check error:', spentError)
        return { success: false, error: spentError.message }
      }
      if (spentRows && spentRows.length > 0) {
        return {
          success: false,
          error: 'This bank transaction is already reconciled against another bill.',
        }
      }

      // Amendment F: key off the bill's CURRENT status, not the stored match_type
      const payResult = await applyBillPayment(supabase, logRow.bill_id, bankAmount, bankDate, payMethod)
      if (!payResult.success) {
        return { success: false, error: payResult.error }
      }
    }

    // Set this row confirmed
    const { error: updateError } = await supabase
      .from('finance_reconciliation_log')
      .update({
        status: 'confirmed',
        applied_by: userId,
        applied_at: new Date().toISOString(),
      })
      .eq('id', logId)

    if (updateError) {
      console.error('confirmReconciliationMatch update error:', updateError)
      return { success: false, error: updateError.message }
    }

    // Amendment D: dismiss conflicting pending_review rows on BOTH sides —
    // same bank_bs_id (other proposals for this charge) or same bill_id
    // (other proposals pointing at this bill).
    const orFilter = logRow.bill_id
      ? `bank_bs_id.eq.${logRow.bank_bs_id},bill_id.eq.${logRow.bill_id}`
      : `bank_bs_id.eq.${logRow.bank_bs_id}`

    const { error: dismissError } = await supabase
      .from('finance_reconciliation_log')
      .update({ status: 'dismissed', applied_at: new Date().toISOString() })
      .eq('status', 'pending_review')
      .neq('id', logId)
      .or(orFilter)

    if (dismissError) {
      // Non-fatal: log but don't fail the confirm
      console.error('confirmReconciliationMatch dismiss-conflicts error:', dismissError)
    }

    return { success: true }
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
// RPC (20260728130000_assign_reconciliation_match_rpc.sql). The original
// implementation applied the bill payment and recorded the log row in two
// separate statements — if the second failed, the bill was left paid with
// no record of why, and a retry against a different bill could pay it too.
// The RPC does everything in one Postgres transaction with row-level locks
// (SELECT ... FOR UPDATE) on both the log row and the target bill, so it's
// impossible to observe a partially-applied result, and concurrent calls
// (double-submit, or two different suggestions both targeting the same
// bill) serialize instead of racing.

// Mirrors the error_code values assign_reconciliation_match() can return.
// BUG-3 fix (SPRO-43 live-testing round): error_code was declared and
// threaded through the RPC but never actually read by the caller — every
// rejection reason rendered as the same generic toast. 'auto_applied_conflict'
// and 'bank_txn_spent' specifically mean the CALLER'S VIEW IS STALE (someone
// else reconciled this bill/transaction between page load and this click),
// so those two also trigger a data refresh, not just an error toast.
export type AssignMatchErrorCode =
  | 'log_not_found'
  | 'not_pending'
  | 'target_required'
  | 'bill_not_found'
  | 'bill_void'
  | 'already_reconciled'
  | 'bank_txn_spent'
  | 'auto_applied_conflict'
  | 'invalid_amount'
  | 'check_requires_ref'

interface AssignReconciliationMatchRpcResult {
  success: boolean
  error_code: AssignMatchErrorCode | null
  error_message: string | null
}

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

    const { data, error } = await supabase.rpc('assign_reconciliation_match', {
      p_log_id: logId,
      p_target_bill_id: targetBillId,
      p_user_id: userId,
    })

    if (error) {
      console.error('assignReconciliationMatch RPC error:', error)
      return { success: false, error: error.message }
    }

    const row = (Array.isArray(data) ? data[0] : data) as AssignReconciliationMatchRpcResult | undefined

    if (!row?.success) {
      return {
        success: false,
        error: row?.error_message ?? 'Failed to assign match',
        errorCode: row?.error_code ?? undefined,
      }
    }

    return { success: true }
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
