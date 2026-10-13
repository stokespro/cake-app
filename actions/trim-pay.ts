'use server'

// Harvest & Trim, Phase 3: batch close, per-trimmer pay review and approval (which raises the finance
// bill), reversal, reopen, and the finance pay register.
//
// Authorization is enforced HERE (RLS is not a backstop): every exported function calls requireRole() or
// requireFinance() first. The actor is always auth.session.userId. The only client inputs are ids, the due
// date, the confirmed hanger count and reasons - never an amount, a rate or a flower weight: the DB
// functions sum the pay entries themselves, under lock.
//
// The bill is raised INSIDE fn_trim_approve_payout (SECURITY DEFINER), so this file never calls
// createBill, never touches finance_bills / finance_bill_payments directly, and the trim manager needs
// only TRIM_PAY_APPROVE_ROLES, not the finance module (R2.14 / R2.15). Payment state is always read back
// from the bill, which the finance ledger derives; nothing here maintains it.
//
// fn_trim_reopen_batch does NOT check the caller's role in the database. REOPEN_ROLES below is the only
// gate on that action.
//
// A 'use server' module may only export async functions (scripts/check-server-exports.mjs fails the
// build on re-exports). Type declarations are erased and fine.

import { requireFinance, requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { TRIM_OPS_ROLES, TRIM_PAY_APPROVE_ROLES } from '@/lib/trim/roles'
import { sumMoney } from '@/lib/trim/pay'
import { GENERIC_ERROR, dbFailure, denied, fail, invalid } from '@/lib/trim/db-errors'
import { gramsToLb, roundLb, roundTo } from '@/lib/units'
import type { ActionResult } from '@/types/harvest-trim'

/** Reopening a closed batch is admin-only, and the DB does not enforce it. */
const REOPEN_ROLES: string[] = ['admin']

// ─── Shared plumbing (error mapping lives in lib/trim/db-errors.ts; a 'use server' file cannot export helpers) ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function ok<T>(data: T): ActionResult<T> {
  return { success: true, data }
}

type Row = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function one(v: unknown): Row | null {
  if (Array.isArray(v)) return (v[0] as Row | undefined) ?? null
  return v && typeof v === 'object' ? (v as Row) : null
}

function many(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : []
}

function cleanReason(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= 3 && t.length <= 500 ? t : null
}

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** One rpc call; a null / empty / non-object result is a failure, never a success. */
async function callRpc(label: string, fn: string, params: Record<string, unknown>): Promise<ActionResult<Row>> {
  try {
    const db = await createServiceClient()
    const { data, error } = await db.rpc(fn, params)
    if (error) return dbFailure(label, error)
    if (data === null || data === undefined || typeof data !== 'object' || (Array.isArray(data) && data.length === 0)) {
      console.error(`[harvest-trim] ${label} error: empty rpc result from ${fn}`)
      return fail(GENERIC_ERROR)
    }
    return ok((Array.isArray(data) ? data[0] : data) as Row)
  } catch (err) {
    return dbFailure(label, err)
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CloseBatchResult {
  batchId: string
  batchName: string
  trimClosedAt: string | null
  reconciledLoads: number
  voidLoads: number
  hangers: number
  /** Pay entries moved open -> ready. No money has moved and no bill exists yet. */
  readyEntries: number
  totalFlowerG: number
  totalAmount: number
  trimmers: Array<{ trimmerId: string; trimmerName: string; entries: number; flowerG: number; amount: number }>
}

export interface ReopenBatchResult {
  batchId: string
  batchName: string
  entriesReopened: number
  previouslyClosedAt: string | null
}

export interface ApprovePayoutResult {
  payoutId: string
  billId: string
  billName: string | null
  /** 'unpaid' on creation. */
  billStatus: string | null
  /** First day of the due date's month (derived by the DB, matching finance's derivePeriodMonth). */
  periodMonth: string | null
  batchId: string
  trimmerId: string
  vendorId: string | null
  amount: number
  flowerG: number
  flowerLb: number
  hangers: number
  entryCount: number
  dueDate: string | null
  rateMin: number | null
  rateMax: number | null
  /** True when this trimmer's rate differs from the one on their previous approved payout. */
  rateChanged: boolean
  previousRateMin: number | null
  previousRateMax: number | null
}

export interface ReversePayoutResult {
  payoutId: string
  billId: string | null
  /** 'void' after a successful reversal. */
  billStatus: string | null
  amount: number | null
  entriesReturned: number
}

export interface PayoutReviewPayout {
  payoutId: string
  billId: string | null
  status: 'approved' | 'reversed'
  amount: number
  flowerG: number
  dueDate: string | null
  approvedAt: string | null
  /** From the finance bill, read live: unpaid | partial | paid | void. */
  billStatus: string | null
  billAmount: number | null
  amountPaid: number | null
}

export interface PayoutReviewTrimmer {
  trimmerId: string
  trimmerName: string
  /** Distinct hangers this trimmer returned material from. */
  hangers: number
  hangerCodes: string[]
  /** Returned episodes (a hanger can be trimmed in several sittings). */
  episodes: number
  flowerG: number
  flowerLb: number
  /** Distinct $/lb applied across this trimmer's pay lines, ascending (more than one = a rate change mid-batch). */
  ratesPerLb: number[]
  /** Sum of this trimmer's pay lines on the batch. */
  amountOwed: number
  openEntries: number
  readyEntries: number
  approvedEntries: number
  /** Returned episodes still flagged for variance. No pay line exists for a flagged return, so these are owed nothing yet. */
  flaggedEpisodes: number
  vendorId: string | null
  vendorName: string | null
  /** Null when the trimmer has no vendor linked. */
  vendorActive: boolean | null
  /** The current approved payout, or null. */
  payout: PayoutReviewPayout | null
  /** Batch closed, nothing approved yet, something ready to pay, and an active vendor linked. The DB re-checks everything. */
  canApprove: boolean
}

export interface PayoutReviewBlocker {
  hangerCode: string
  /** hung | dried | checked_out | partial | flagged (a return awaiting variance resolution). */
  status: string
}

export interface BatchPayoutReview {
  batchId: string
  batchName: string
  strainName: string | null
  close: {
    closed: boolean
    closedAt: string | null
    closedByName: string | null
    reconciledLoads: number
    voidLoads: number
    /** Loads that are neither reconciled nor void; any of them blocks the close. */
    unfinishedLoads: PayoutReviewBlocker[]
  }
  /** By trimmer name. */
  trimmers: PayoutReviewTrimmer[]
  totals: {
    trimmers: number
    flowerG: number
    flowerLb: number
    amountOwed: number
    approvedTrimmers: number
    approvedAmount: number
    flaggedEpisodes: number
  }
}

export type PayRegisterStatus = 'approved' | 'reversed' | 'unpaid' | 'partial' | 'paid'

export interface PayRegisterRow {
  payoutId: string
  billId: string | null
  batchId: string
  batchName: string | null
  trimmerId: string
  trimmerName: string | null
  vendorId: string
  vendorName: string | null
  flowerG: number
  flowerLb: number
  amount: number
  dueDate: string
  /** The trim side: approved | reversed. */
  payoutStatus: 'approved' | 'reversed'
  /** From the finance ledger: unpaid | partial | paid | void. */
  billStatus: string | null
  billAmount: number | null
  amountPaid: number | null
  paidDate: string | null
  /** amount - amountPaid for an approved payout; 0 once reversed. */
  balance: number
  approvedByName: string | null
  approvedAt: string | null
  reversedAt: string | null
  reverseReason: string | null
}

export interface PayRegister {
  from: string
  to: string
  rows: PayRegisterRow[]
  totals: { payouts: number; approvedAmount: number; amountPaid: number; outstanding: number }
  /** True when more than the row cap matched; narrow the range. */
  truncated: boolean
}

// ─── Close / reopen ──────────────────────────────────────────────────────────

/**
 * Close a batch: every load must be reconciled or void, and the DB names up to 12 blocking hangers in
 * the error ("H1B-003 (partial), H1B-004 (hung)") - that message is passed through verbatim.
 * `confirmedHangerCount` (the count the user typed after looking at the rack) is checked by the database
 * under its lock; it is optional so a caller without the speed bump still works, but when present it is
 * forwarded as given and never pre-checked here.
 */
export async function closeTrimBatch(input: {
  batchId: string
  confirmedHangerCount?: number | null
}): Promise<ActionResult<CloseBatchResult>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const { batchId, confirmedHangerCount } = input ?? ({} as typeof input)
  if (!isUuid(batchId)) return invalid('Unknown batch.')
  const hasCount = confirmedHangerCount !== undefined && confirmedHangerCount !== null
  if (hasCount && (!Number.isInteger(confirmedHangerCount) || confirmedHangerCount < 0 || confirmedHangerCount > 10000)) {
    return invalid('The confirmed hanger count must be a whole number.')
  }

  const params: Record<string, unknown> = { p_batch_id: batchId, p_actor: auth.session.userId }
  if (hasCount) params.p_confirmed_hanger_count = confirmedHangerCount
  const res = await callRpc('closeTrimBatch', 'fn_trim_close_batch', params)
  if (!res.success) return res

  const d = res.data
  return ok({
    batchId: String(d.batch_id ?? batchId),
    batchName: str(d.batch_name) ?? '',
    trimClosedAt: str(d.trim_closed_at),
    reconciledLoads: num(d.reconciled_loads) ?? 0,
    voidLoads: num(d.void_loads) ?? 0,
    hangers: num(d.hangers) ?? 0,
    readyEntries: num(d.ready_entries) ?? 0,
    totalFlowerG: num(d.total_flower_g) ?? 0,
    totalAmount: num(d.total_amount) ?? 0,
    trimmers: many(d.trimmers).map((t) => ({
      trimmerId: String(t.trimmer_id),
      trimmerName: str(t.trimmer_name) ?? '',
      entries: num(t.entries) ?? 0,
      flowerG: num(t.flower_g) ?? 0,
      amount: num(t.amount) ?? 0,
    })),
  })
}

/**
 * Reopen a closed batch (pay entries go ready -> open). ADMIN ONLY, and this gate is the whole control:
 * fn_trim_reopen_batch does not look at the caller's role. The DB refuses while any payout is approved.
 */
export async function reopenTrimBatch(input: {
  batchId: string
  reason: string
}): Promise<ActionResult<ReopenBatchResult>> {
  const auth = await requireRole(REOPEN_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const { batchId, reason } = input ?? ({} as typeof input)
  if (!isUuid(batchId)) return invalid('Unknown batch.')
  const why = cleanReason(reason)
  if (!why) return invalid('A reason of at least 3 characters is required.')

  const res = await callRpc('reopenTrimBatch', 'fn_trim_reopen_batch', {
    p_batch_id: batchId,
    p_reason: why,
    p_actor: auth.session.userId,
  })
  if (!res.success) return res

  const d = res.data
  return ok({
    batchId: String(d.batch_id ?? batchId),
    batchName: str(d.batch_name) ?? '',
    entriesReopened: num(d.entries_reopened) ?? 0,
    previouslyClosedAt: str(d.previously_closed_at),
  })
}

// ─── Approve / reverse ───────────────────────────────────────────────────────

/**
 * Approve one trimmer's pay on a closed batch and raise their bill, in one database transaction.
 * The amount, flower weight and rate come from the pay entries inside the function; the client supplies
 * only which batch, which trimmer and when it is due. The database refuses: batch not closed, no vendor
 * linked, inactive vendor, nothing owed, due date before the trim-close or over a year out, and a
 * (batch, trimmer) pair that is already approved.
 */
export async function approveTrimPayout(input: {
  batchId: string
  trimmerId: string
  dueDate: string
}): Promise<ActionResult<ApprovePayoutResult>> {
  const auth = await requireRole(TRIM_PAY_APPROVE_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const { batchId, trimmerId, dueDate } = input ?? ({} as typeof input)
  if (!isUuid(batchId)) return invalid('Unknown batch.')
  if (!isUuid(trimmerId)) return invalid('Unknown trimmer.')
  if (!validDate(dueDate)) return invalid('A due date is required (YYYY-MM-DD).')

  const res = await callRpc('approveTrimPayout', 'fn_trim_approve_payout', {
    p_batch_id: batchId,
    p_trimmer_id: trimmerId,
    p_due_date: dueDate,
    p_actor: auth.session.userId,
  })
  if (!res.success) return res

  const d = res.data
  const payout = one(d.payout)
  const bill = one(d.bill)
  const payoutId = str(payout?.id)
  const billId = str(bill?.id)
  if (!payoutId || !billId) {
    // The transaction committed or it did not; either way this shape is unusable, so say so loudly.
    console.error('[harvest-trim] approveTrimPayout error: rpc result is missing payout / bill', d)
    return fail(GENERIC_ERROR)
  }
  const flowerG = num(d.flower_g) ?? 0
  return ok({
    payoutId,
    billId,
    billName: str(bill?.name),
    billStatus: str(bill?.status),
    periodMonth: str(bill?.period_month),
    batchId,
    trimmerId,
    vendorId: str(payout?.vendor_id),
    amount: num(d.amount) ?? 0,
    flowerG,
    flowerLb: roundLb(gramsToLb(flowerG)),
    hangers: num(d.hangers) ?? 0,
    entryCount: num(d.entry_count) ?? 0,
    dueDate: str(payout?.due_date) ?? dueDate,
    rateMin: num(d.rate_min),
    rateMax: num(d.rate_max),
    rateChanged: d.rate_changed === true,
    previousRateMin: num(d.previous_rate_min),
    previousRateMax: num(d.previous_rate_max),
  })
}

/**
 * Reverse an approved payout: the bill is voided (not deleted), the entries return to ready. The reason
 * is mandatory (3-500 chars) and checked before any database call. The DB refuses once the bill has any
 * payment on it - that has to be corrected in finance.
 */
export async function reverseTrimPayout(input: {
  payoutId: string
  reason: string
}): Promise<ActionResult<ReversePayoutResult>> {
  const auth = await requireRole(TRIM_PAY_APPROVE_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const { payoutId, reason } = input ?? ({} as typeof input)
  if (!isUuid(payoutId)) return invalid('Unknown payout.')
  const why = cleanReason(reason)
  if (!why) return invalid('A reason of at least 3 characters is required.')

  const res = await callRpc('reverseTrimPayout', 'fn_trim_reverse_payout', {
    p_payout_id: payoutId,
    p_reason: why,
    p_actor: auth.session.userId,
  })
  if (!res.success) return res

  const d = res.data
  const payout = one(d.payout)
  const bill = one(d.bill)
  return ok({
    payoutId: str(payout?.id) ?? payoutId,
    billId: str(bill?.id),
    billStatus: str(bill?.status),
    amount: num(payout?.amount),
    entriesReturned: num(d.entries_returned) ?? 0,
  })
}

// ─── Review (the commissions-style screen) ───────────────────────────────────

const REVIEW_SELECT =
  'id, name, trim_closed_at, strain:strains(id, name), ' +
  'closed_by:users!batches_trim_closed_by_fkey(name), ' +
  'hanger_loads(id, status, hanger:hangers(code), ' +
  'trim_checkouts(id, trimmer_id, trimmer_name, status, variance_status, rate_per_lb_applied, flower_g, ' +
  'trimmer:trim_staff(id, vendor_id, vendor:finance_vendors(id, name, is_active)), ' +
  'trim_pay_entries(id, amount, flower_g, status))), ' +
  'trim_payouts(id, trimmer_id, bill_id, status, amount, flower_g, due_date, approved_at, ' +
  'finance_bills(id, status, amount, amount_paid))'

/**
 * Everything the pay review screen needs for one batch, in ONE round trip (batches -> loads -> episodes
 * -> pay entries / trimmer / vendor, and batches -> payouts -> bill). Per trimmer: hangers, episodes,
 * flower, rate(s) applied, amount owed, any episodes still flagged, vendor linkage, and the existing
 * payout with its live bill status.
 *
 * Void loads are included in the per-trimmer sums: voiding a partial load leaves the earlier episodes'
 * pay lines in place (the work was done and is owed), and the close-time reconciliation counts them.
 */
export async function getBatchPayoutReview(batchId: string): Promise<ActionResult<BatchPayoutReview>> {
  const auth = await requireRole(TRIM_PAY_APPROVE_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(batchId)) return invalid('Unknown batch.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db.from('batches').select(REVIEW_SELECT).eq('id', batchId).maybeSingle()
    if (error) return dbFailure('getBatchPayoutReview', error)
    if (!data) return fail('Batch not found.', 'NOT_FOUND')

    const batch = data as unknown as Row
    const closedAt = str(batch.trim_closed_at)
    const closed = closedAt !== null

    interface Acc {
      name: string
      loadKeys: Set<string>
      hangerCodes: Set<string>
      episodes: number
      flower: number
      rates: Set<number>
      amounts: number[]
      open: number
      ready: number
      approved: number
      flagged: number
      vendorId: string | null
      vendorName: string | null
      vendorActive: boolean | null
    }
    const byTrimmer = new Map<string, Acc>()
    const unfinishedLoads: PayoutReviewBlocker[] = []
    let reconciledLoads = 0
    let voidLoads = 0

    for (const load of many(batch.hanger_loads)) {
      const status = String(load.status)
      const code = str(one(load.hanger)?.code) ?? ''
      if (status === 'void') voidLoads++
      else if (status === 'reconciled') reconciledLoads++
      else unfinishedLoads.push({ hangerCode: code, status: status === 'returned' ? 'flagged' : status })

      for (const e of many(load.trim_checkouts)) {
        if (e.status !== 'returned') continue
        const trimmerId = String(e.trimmer_id)
        let a = byTrimmer.get(trimmerId)
        if (!a) {
          const staff = one(e.trimmer)
          const vendor = one(staff?.vendor)
          a = {
            name: str(e.trimmer_name) ?? '',
            loadKeys: new Set(),
            hangerCodes: new Set(),
            episodes: 0,
            flower: 0,
            rates: new Set(),
            amounts: [],
            open: 0,
            ready: 0,
            approved: 0,
            flagged: 0,
            vendorId: str(staff?.vendor_id),
            vendorName: str(vendor?.name),
            vendorActive: vendor ? vendor.is_active === true : null,
          }
          byTrimmer.set(trimmerId, a)
        }
        a.episodes++
        a.loadKeys.add(String(load.id))
        a.hangerCodes.add(code || String(load.id))
        a.flower += num(e.flower_g) ?? 0
        if (e.variance_status === 'flagged') a.flagged++
        const entry = one(e.trim_pay_entries)
        if (entry) {
          const amount = num(entry.amount)
          if (amount !== null) a.amounts.push(amount)
          const rate = num(e.rate_per_lb_applied)
          if (rate !== null) a.rates.add(rate)
          if (entry.status === 'open') a.open++
          else if (entry.status === 'ready') a.ready++
          else if (entry.status === 'approved') a.approved++
        }
      }
    }

    // The one live (approved) payout per trimmer; a reversed one no longer holds the work.
    const payoutByTrimmer = new Map<string, PayoutReviewPayout>()
    for (const p of many(batch.trim_payouts)) {
      if (p.status !== 'approved') continue
      const bill = one(p.finance_bills)
      payoutByTrimmer.set(String(p.trimmer_id), {
        payoutId: String(p.id),
        billId: str(p.bill_id),
        status: 'approved',
        amount: num(p.amount) ?? 0,
        flowerG: num(p.flower_g) ?? 0,
        dueDate: str(p.due_date),
        approvedAt: str(p.approved_at),
        billStatus: str(bill?.status),
        billAmount: num(bill?.amount),
        amountPaid: num(bill?.amount_paid),
      })
    }

    const trimmers: PayoutReviewTrimmer[] = [...byTrimmer.entries()]
      .map(([trimmerId, a]) => {
        const amountOwed = sumMoney(a.amounts)
        const payout = payoutByTrimmer.get(trimmerId) ?? null
        return {
          trimmerId,
          trimmerName: a.name,
          hangers: a.hangerCodes.size,
          hangerCodes: [...a.hangerCodes].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
          episodes: a.episodes,
          flowerG: roundTo(a.flower, 2),
          flowerLb: roundLb(gramsToLb(a.flower)),
          ratesPerLb: [...a.rates].sort((x, y) => x - y),
          amountOwed,
          openEntries: a.open,
          readyEntries: a.ready,
          approvedEntries: a.approved,
          flaggedEpisodes: a.flagged,
          vendorId: a.vendorId,
          vendorName: a.vendorName,
          vendorActive: a.vendorActive,
          payout,
          canApprove: closed && payout === null && a.ready > 0 && amountOwed > 0 && a.vendorActive === true,
        }
      })
      .sort((x, y) => x.trimmerName.localeCompare(y.trimmerName))

    const flowerG = trimmers.reduce((s, t) => s + t.flowerG, 0)
    const approved = trimmers.filter((t) => t.payout !== null)
    unfinishedLoads.sort((x, y) => x.hangerCode.localeCompare(y.hangerCode, undefined, { numeric: true }))

    return ok({
      batchId: String(batch.id),
      batchName: String(batch.name),
      strainName: str(one(batch.strain)?.name),
      close: {
        closed,
        closedAt,
        closedByName: str(one(batch.closed_by)?.name),
        reconciledLoads,
        voidLoads,
        unfinishedLoads,
      },
      trimmers,
      totals: {
        trimmers: trimmers.length,
        flowerG: roundTo(flowerG, 2),
        flowerLb: roundLb(gramsToLb(flowerG)),
        amountOwed: sumMoney(trimmers.map((t) => t.amountOwed)),
        approvedTrimmers: approved.length,
        approvedAmount: sumMoney(approved.map((t) => t.payout?.amount ?? 0)),
        flaggedEpisodes: trimmers.reduce((s, t) => s + t.flaggedEpisodes, 0),
      },
    })
  } catch (err) {
    return dbFailure('getBatchPayoutReview', err)
  }
}

// ─── Pay register (finance) ──────────────────────────────────────────────────

const REGISTER_ROW_CAP = 1000
const MAX_RANGE_DAYS = 366
const REGISTER_STATUSES: readonly string[] = ['approved', 'reversed', 'unpaid', 'partial', 'paid']

/**
 * Payouts with their bills, for payroll. Finance only (admin, management): the trim manager approves
 * pay but has no finance access. `from`/`to` (inclusive, YYYY-MM-DD) bound the payout DUE DATE. Payment
 * state (billStatus, amountPaid, paidDate) is read from the finance bill, which the finance ledger
 * derives; nothing about payment is stored or computed on the trim side.
 *
 * `status` narrows by payout state ('approved' | 'reversed') or by the bill's payment state
 * ('unpaid' | 'partial' | 'paid', which implies an approved payout). Omitted = everything.
 */
export async function getPayRegister(input: {
  from: string
  to: string
  status?: PayRegisterStatus
}): Promise<ActionResult<PayRegister>> {
  const auth = await requireFinance()
  if (!auth.authorized) return denied(auth.reason)
  const { from, to, status } = input ?? ({} as typeof input)
  if (!validDate(from) || !validDate(to)) return invalid('Choose a valid date range.')
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (days < 0) return invalid('The start date must be on or before the end date.')
  if (days > MAX_RANGE_DAYS) return invalid('Choose a range of a year or less.')
  if (status !== undefined && !REGISTER_STATUSES.includes(status)) return invalid('Unknown status filter.')
  const byBill = status === 'unpaid' || status === 'partial' || status === 'paid'

  try {
    const db = await createServiceClient()
    let q = db
      .from('trim_payouts')
      .select(
        'id, batch_id, trimmer_id, vendor_id, bill_id, flower_g, amount, due_date, status, approved_at, ' +
          'reversed_at, reverse_reason, ' +
          'trimmer:trim_staff(full_name), vendor:finance_vendors(name), batch:batches(name), ' +
          'approver:users!trim_payouts_approved_by_fkey(name), ' +
          `finance_bills${byBill ? '!inner' : ''}(id, status, amount, amount_paid, paid_date)`
      )
      .gte('due_date', from)
      .lte('due_date', to)
    if (status === 'approved' || status === 'reversed') q = q.eq('status', status)
    else if (byBill) q = q.eq('status', 'approved').eq('finance_bills.status', status)
    const { data, error } = await q
      .order('due_date', { ascending: true })
      .order('approved_at', { ascending: false })
      .limit(REGISTER_ROW_CAP + 1)
    if (error) return dbFailure('getPayRegister', error)

    const all = many(data)
    const truncated = all.length > REGISTER_ROW_CAP
    const rows: PayRegisterRow[] = all.slice(0, REGISTER_ROW_CAP).map((r) => {
      const bill = one(r.finance_bills)
      const amount = num(r.amount) ?? 0
      const flowerG = num(r.flower_g) ?? 0
      const payoutStatus = r.status === 'reversed' ? 'reversed' : 'approved'
      const amountPaid = num(bill?.amount_paid)
      return {
        payoutId: String(r.id),
        billId: str(r.bill_id),
        batchId: String(r.batch_id),
        batchName: str(one(r.batch)?.name),
        trimmerId: String(r.trimmer_id),
        trimmerName: str(one(r.trimmer)?.full_name),
        vendorId: String(r.vendor_id),
        vendorName: str(one(r.vendor)?.name),
        flowerG,
        flowerLb: roundLb(gramsToLb(flowerG)),
        amount,
        dueDate: String(r.due_date),
        payoutStatus,
        billStatus: str(bill?.status),
        billAmount: num(bill?.amount),
        amountPaid,
        paidDate: str(bill?.paid_date),
        balance: payoutStatus === 'approved' ? Math.max(0, roundTo(amount - (amountPaid ?? 0), 2)) : 0,
        approvedByName: str(one(r.approver)?.name),
        approvedAt: str(r.approved_at),
        reversedAt: str(r.reversed_at),
        reverseReason: str(r.reverse_reason),
      }
    })

    const live = rows.filter((r) => r.payoutStatus === 'approved')
    return ok({
      from,
      to,
      rows,
      totals: {
        payouts: live.length,
        approvedAmount: sumMoney(live.map((r) => r.amount)),
        amountPaid: sumMoney(live.map((r) => r.amountPaid ?? 0)),
        outstanding: sumMoney(live.map((r) => r.balance)),
      },
      truncated,
    })
  } catch (err) {
    return dbFailure('getPayRegister', err)
  }
}
