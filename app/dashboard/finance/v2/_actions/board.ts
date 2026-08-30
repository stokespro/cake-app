'use server'

// Cash Board (v2) — READ-ONLY data layer. Phase 0a of the finance redesign.
//
// HARD RULE: this file performs no INSERT/UPDATE/DELETE anywhere. It only
// reads finance_* tables, orders/customers, and a handful of existing
// service-role-only RPCs (get_bank_balance, get_bank_transactions,
// get_untracked_bank_transactions) that actions/finance.ts and
// app/dashboard/finance/_actions/bank.ts already call the same way.
//
// This module is deliberately self-contained: it does not import anything
// from actions/finance.ts, app/dashboard/finance/_actions/bank.ts, or
// lib/finance/* — those are money-path code (four production incidents) and
// are out of scope to touch or couple against. Every type/helper needed here
// is defined locally.
//
// Only async functions are exported from this file (getCashBoard). Types
// live in ../types (a plain module) per scripts/check-server-exports.mjs —
// a 'use server' module must never re-export an imported type/value, or
// Next.js's server-action registration throws at evaluation (SPRO-82).

import { createServiceClient } from '@/lib/supabase/server'
import { requireFinance } from '@/lib/auth/session'
import type {
  CashBoardData,
  AgingBucket,
  AvailabilityTier,
  Verdict,
  MoneyInLine,
  WeekLedger,
  BillTriage,
  Lever,
  DecisionBill,
  DecisionGroup,
  ReceivableItem,
  ReceivablesPanel,
  InflowForecast,
  ExceptionItem,
  ExceptionGroup,
} from '../types'

// ============================================================
// Date helpers — all date-only arithmetic is done on 'YYYY-MM-DD' strings
// anchored to UTC midnight, mirroring derivePeriodMonth()/computeDueDate()'s
// own rationale in actions/finance.ts: using new Date() with the runtime's
// local timezone for calendar-day math is a timezone-shift bug waiting to
// happen. "Today" itself is read once, in America/Chicago, via
// Intl.DateTimeFormat (same approach as getCentralToday() in
// app/dashboard/finance/page.tsx around line 127) — everything downstream is
// pure string/UTC-date math from that one anchor.
// ============================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000

function getCentralToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function toUTCDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

function toDateStr(d: Date): string {
  return d.toISOString().substring(0, 10)
}

function addDays(dateStr: string, days: number): string {
  return toDateStr(new Date(toUTCDate(dateStr).getTime() + days * MS_PER_DAY))
}

/** Whole days from `fromStr` to `toStr` (positive = toStr is later). */
function daysBetween(fromStr: string, toStr: string): number {
  return Math.round((toUTCDate(toStr).getTime() - toUTCDate(fromStr).getTime()) / MS_PER_DAY)
}

/** Monday of the ISO week containing `dateStr` (Mon..Sun weeks, matching Postgres date_trunc('week', ...)). */
function mondayOf(dateStr: string): string {
  const dow = toUTCDate(dateStr).getUTCDay() // 0 = Sunday .. 6 = Saturday
  const offsetToMonday = dow === 0 ? -6 : 1 - dow
  return addDays(dateStr, offsetToMonday)
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

/** Linear-interpolation percentile (numpy's default "linear" method) over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = (p / 100) * (sortedAsc.length - 1)
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return sortedAsc[lower]
  const weight = idx - lower
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight
}

/** Uppercase, strip digit runs of 3+, collapse whitespace — for grouping recurring untracked bank descriptions. */
function normalizeDescription(desc: string): string {
  return desc
    .toUpperCase()
    .replace(/\d{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pattern key for recurring_unplanned grouping. Transfers are keyed by
 * DESTINATION ACCOUNT rather than the generic normalizeDescription() above —
 * that generic pass strips 3+ digit runs, which erases the account number
 * (X5514/X1210/X1752/...) that is the actual signal distinguishing "payroll
 * funding" from "management fee" from every other internal transfer. Two
 * transfers to different accounts are different recurring obligations even
 * when their free-text memo varies (or is absent); two transfers to the same
 * account are the same obligation even when their memo varies. Falls back to
 * normalizeDescription() for anything that isn't a "TO X####" transfer.
 */
function recurringPatternKey(desc: string): string {
  const transferMatch = desc.match(/\bTO\s+X(\d+)/i)
  if (transferMatch) {
    return `TRANSFER → X${transferMatch[1]}`
  }
  return normalizeDescription(desc)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ============================================================
// Local row shapes — mirror the RPCs/tables read here. Kept local rather
// than imported from bank.ts/actions/finance.ts to keep this read-only
// module fully decoupled from the money-path files it must not touch.
// ============================================================

interface VendorJoin {
  name: string
}

type VendorEmbed = VendorJoin | VendorJoin[] | null

function vendorNameOf(v: VendorEmbed): string | null {
  return Array.isArray(v) ? (v[0]?.name ?? null) : (v?.name ?? null)
}

interface BillRow {
  id: string
  name: string
  amount: number
  amount_paid: number
  due_date: string
  status: string
  vendor: VendorEmbed
}

interface ActiveBill extends BillRow {
  remaining: number
}

interface RawBankTxn {
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

interface BankBalanceRpcRow {
  current_balance: number
  available_balance: number
  pending_balance: number
  account_number: string
  as_of_date: string
  account_name: string
  bank: string
  account_id: string
}

/**
 * Awaits a Supabase PostgrestFilterBuilder (the `.rpc()`/`.from()` return
 * type — thenable, but not a real Promise, so it has no `.catch()`) and
 * normalizes a thrown error into the same `{ data: null, error }` shape
 * Supabase itself returns for a non-throwing failure. Used for RPCs this
 * screen treats as non-fatal enrichments (bank balance, bank transactions,
 * untracked transactions) — a failure here degrades gracefully rather than
 * failing the whole board.
 */
async function safeQuery<T>(
  builder: PromiseLike<{ data: T | null; error: unknown }>
): Promise<{ data: T | null; error: unknown }> {
  try {
    return await builder
  } catch (err) {
    return { data: null, error: err }
  }
}

// ============================================================
// getCashBoard
// ============================================================

export async function getCashBoard(): Promise<{
  success: boolean
  data?: CashBoardData
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const today = getCentralToday()
    const windowEnd = addDays(today, 7) // ledger window: today -> today+7, inclusive
    const horizon14 = addDays(today, 14) // decisionGroups window
    const since30 = addDays(today, -30) // avgDailyOutflow window
    const since90 = addDays(today, -90) // paid_no_bank_trail window

    // Trailing 12 COMPLETE weeks (Mon..Sun) for the inflow forecast —
    // explicitly excludes the current in-progress week, matching
    // date_trunc('week', current_date) as the cutoff.
    const currentWeekMonday = mondayOf(today)
    const lastCompleteWeekEnd = addDays(currentWeekMonday, -1) // Sunday before this week
    const weeks: { start: string; end: string }[] = []
    for (let i = 11; i >= 0; i--) {
      const end = addDays(lastCompleteWeekEnd, -7 * i)
      const start = addDays(end, -6)
      weeks.push({ start, end })
    }
    const earliestWeekStart = weeks[0].start

    // ---- Round 1: independent reads, fired in parallel -------------------
    const [
      snapshotRes,
      bankBalanceRes,
      bankTxns30Res,
      activeBillsRes,
      noBankTrailRes,
      untrackedRes,
      receivablesRes,
      deliveredRes,
      pipelineRes,
      pipelineDatesRes,
    ] = await Promise.all([
      supabase
        .from('finance_cash_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: false })
        .limit(1),

      // Non-fatal enrichment — degrade to the snapshot on any failure.
      safeQuery<BankBalanceRpcRow[]>(supabase.rpc('get_bank_balance')),

      // Non-fatal — avgDailyOutflow just falls back to 0 (daysOfCashLeft -> null) on failure.
      safeQuery<RawBankTxn[]>(supabase.rpc('get_bank_transactions', { since_date: since30 })),

      // ALL unpaid/partial bills, no due_date bound — every ledger/triage/
      // decision/exception computation below that needs bills works off this
      // one fetch and filters client-side, rather than re-querying per concern.
      supabase
        .from('finance_bills')
        .select('id, name, amount, amount_paid, due_date, status, vendor:finance_vendors(name)')
        .in('status', ['unpaid', 'partial'])
        .order('due_date', { ascending: true })
        .range(0, 4999),

      // paid_no_bank_trail: ANY bill's payments (not just unpaid/partial —
      // a bill can be fully 'paid' and still have an unreconciled payment
      // row), so this is scoped independently of the bills fetch above.
      supabase
        .from('finance_bill_payments')
        .select('id, amount, paid_date, payment_method, bill:finance_bills(name, vendor:finance_vendors(name))')
        .is('bank_bs_id', null)
        .gte('paid_date', since90)
        .order('paid_date', { ascending: false })
        .range(0, 4999),

      // Non-fatal — money_out_no_bill / recurring_unplanned just come back empty on failure.
      safeQuery<RawBankTxn[]>(supabase.rpc('get_untracked_bank_transactions')),

      // Terms orders, unpaid, delivered — feeds both the ledger's terms_due /
      // ar_overdue moneyIn lines (split on terms_payment_date vs today) and
      // the receivables panel below. Left exactly as it was verified.
      supabase
        .from('orders')
        .select('id, order_number, total_price, delivered_at, terms_payment_date, customers(business_name)')
        .eq('payment_terms', true)
        .is('terms_paid_at', null)
        .eq('status', 'delivered')
        .range(0, 4999),

      supabase
        .from('orders')
        .select('id, total_price, delivered_at')
        .eq('status', 'delivered')
        .gte('delivered_at', `${earliestWeekStart}T00:00:00`)
        .lt('delivered_at', `${addDays(weeks[weeks.length - 1].end, 1)}T00:00:00`)
        .range(0, 4999),

      supabase
        .from('orders')
        .select('id, total_price')
        .in('status', ['pending', 'confirmed', 'packed'])
        .range(0, 4999),

      // Separate from pipelineRes above (kept byte-for-byte identical since
      // inflowForecast.pipelineNow is verified) — this fetch adds status and
      // requested_delivery_date so the ledger's deliveries/pending moneyIn
      // lines can be windowed by date without touching that query.
      supabase
        .from('orders')
        .select('id, status, total_price, requested_delivery_date')
        .in('status', ['pending', 'confirmed', 'packed'])
        .range(0, 4999),
    ])

    if (snapshotRes.error) {
      console.error('getCashBoard: error fetching cash snapshot:', snapshotRes.error)
      return { success: false, error: snapshotRes.error.message }
    }
    if (activeBillsRes.error) {
      console.error('getCashBoard: error fetching bills:', activeBillsRes.error)
      return { success: false, error: activeBillsRes.error.message }
    }
    if (noBankTrailRes.error) {
      console.error('getCashBoard: error fetching unreconciled payments:', noBankTrailRes.error)
      return { success: false, error: noBankTrailRes.error.message }
    }
    if (receivablesRes.error) {
      console.error('getCashBoard: error fetching receivables:', receivablesRes.error)
      return { success: false, error: receivablesRes.error.message }
    }
    if (deliveredRes.error) {
      console.error('getCashBoard: error fetching delivered orders:', deliveredRes.error)
      return { success: false, error: deliveredRes.error.message }
    }
    if (pipelineRes.error) {
      console.error('getCashBoard: error fetching pipeline orders:', pipelineRes.error)
      return { success: false, error: pipelineRes.error.message }
    }
    if (pipelineDatesRes.error) {
      console.error('getCashBoard: error fetching pipeline order dates:', pipelineDatesRes.error)
      return { success: false, error: pipelineDatesRes.error.message }
    }

    // ---- Hero: cash on hand -------------------------------------------
    const snapshot = snapshotRes.data?.[0] ?? null

    let cashOnHand = snapshot ? Number(snapshot.cash_on_hand) : 0
    let cashSource: 'bank' | 'manual' = snapshot?.source === 'bank' ? 'bank' : 'manual'
    let asOfDate = snapshot?.snapshot_date ?? today

    const bankBalanceRow = (
      !bankBalanceRes.error && bankBalanceRes.data
        ? Array.isArray(bankBalanceRes.data)
          ? bankBalanceRes.data[0]
          : bankBalanceRes.data
        : null
    ) as BankBalanceRpcRow | null

    if (bankBalanceRow) {
      cashOnHand = Number(bankBalanceRow.current_balance)
      cashSource = 'bank'
      asOfDate = String(bankBalanceRow.as_of_date)
    }

    const isStale = asOfDate < today

    // ---- Hero: avgDailyOutflow / daysOfCashLeft ------------------------
    const bankTxns30 = (bankTxns30Res.error ? [] : (bankTxns30Res.data as RawBankTxn[] | null)) ?? []
    const totalDebits30 = bankTxns30
      .filter((t) => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0)
    const avgDailyOutflow = totalDebits30 / 30
    const daysOfCashLeft = avgDailyOutflow > 0 ? round1(cashOnHand / avgDailyOutflow) : null

    // ---- Bills: shared base for the ledger, triage, decision groups, and
    //      the past_due_unpaid / stalled_partial exception groups ---------
    const allActiveBills: ActiveBill[] = ((activeBillsRes.data ?? []) as BillRow[]).map((b) => ({
      ...b,
      remaining: Number(b.amount) - Number(b.amount_paid),
    }))

    // ---- Receivables source rows — hoisted here so the ledger's terms_due /
    //      ar_overdue moneyIn lines and the receivables panel (Panel 2, below)
    //      read the exact same fetch/parse rather than duplicating it.
    interface ReceivableOrderRow {
      id: string
      order_number: string | null
      total_price: number | null
      delivered_at: string | null
      terms_payment_date: string | null
      customers: { business_name: string } | { business_name: string }[] | null
    }
    const receivableOrders = (receivablesRes.data ?? []) as unknown as ReceivableOrderRow[]

    // ============================================================
    // ledger: WeekLedger — what's owed vs. what money is coming, by tier
    // ============================================================

    const termsUnpaidOrders = receivableOrders.filter((o) => o.terms_payment_date !== null)
    const termsDueOrders = termsUnpaidOrders.filter(
      (o) => (o.terms_payment_date as string) >= today && (o.terms_payment_date as string) <= windowEnd
    )
    const arOverdueOrders = termsUnpaidOrders.filter((o) => (o.terms_payment_date as string) < today)

    const termsDueAmount = termsDueOrders.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    const arOverdueAmount = arOverdueOrders.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    const arOverdueCount = arOverdueOrders.length
    const arOverdueOldestDays = arOverdueOrders.reduce(
      (max, o) => Math.max(max, daysBetween(o.terms_payment_date as string, today)),
      0
    )

    interface PipelineDateOrderRow {
      id: string
      status: string
      total_price: number | null
      requested_delivery_date: string | null
    }
    const pipelineDateOrders = (pipelineDatesRes.data ?? []) as PipelineDateOrderRow[]

    const deliveriesOrders = pipelineDateOrders.filter(
      (o) =>
        (o.status === 'confirmed' || o.status === 'packed') &&
        o.requested_delivery_date !== null &&
        o.requested_delivery_date <= windowEnd
    )
    const pendingOrdersInWindow = pipelineDateOrders.filter(
      (o) => o.status === 'pending' && o.requested_delivery_date !== null && o.requested_delivery_date <= windowEnd
    )
    const deliveriesAmount = deliveriesOrders.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    const pendingAmount = pendingOrdersInWindow.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    const pendingCount = pendingOrdersInWindow.length

    const moneyIn: MoneyInLine[] = [
      {
        key: 'cash',
        label: 'Cash in bank',
        amount: cashOnHand,
        confidence: 'certain',
        tier: 'conservative',
        note: null,
      },
      {
        key: 'deliveries',
        label: 'Deliveries — confirmed + packed',
        amount: deliveriesAmount,
        confidence: 'high',
        tier: 'likely',
        note: null,
      },
      {
        key: 'terms_due',
        label: 'Terms payments due this week',
        amount: termsDueAmount,
        confidence: 'medium',
        tier: 'likely',
        note: null,
      },
      {
        key: 'ar_overdue',
        label: 'Receivables already overdue',
        amount: arOverdueAmount,
        confidence: 'low',
        tier: 'optimistic',
        note: 'already past due — needs chasing',
      },
      {
        key: 'pending',
        label: 'Pending orders, not yet confirmed',
        amount: pendingAmount,
        confidence: 'low',
        tier: 'optimistic',
        note: 'not yet confirmed',
      },
    ]

    // Unpaid+partial bills due within the window (today -> windowEnd,
    // inclusive), including anything already past due.
    const billsInWindow = allActiveBills.filter((b) => b.due_date <= windowEnd && b.remaining > 0)
    const billsDueCount = billsInWindow.length
    const billsDueTotal = billsInWindow.reduce((sum, b) => sum + b.remaining, 0)

    const conservativeAvailable = cashOnHand
    const likelyAvailable = conservativeAvailable + deliveriesAmount + termsDueAmount
    const optimisticAvailable = likelyAvailable + arOverdueAmount + pendingAmount

    const availableByTier: Record<AvailabilityTier, number> = {
      conservative: conservativeAvailable,
      likely: likelyAvailable,
      optimistic: optimisticAvailable,
    }

    function verdictOf(net: number): Verdict {
      if (net < -0.005) return 'short'
      if (net > 0.005) return 'surplus'
      return 'break_even'
    }

    const netByTier: Record<AvailabilityTier, number> = {
      conservative: conservativeAvailable - billsDueTotal,
      likely: likelyAvailable - billsDueTotal,
      optimistic: optimisticAvailable - billsDueTotal,
    }

    const verdictByTier: Record<AvailabilityTier, Verdict> = {
      conservative: verdictOf(netByTier.conservative),
      likely: verdictOf(netByTier.likely),
      optimistic: verdictOf(netByTier.optimistic),
    }

    const defaultTier: AvailabilityTier = 'likely'

    const ledger: WeekLedger = {
      windowStart: today,
      windowEnd,
      moneyIn,
      billsDueCount,
      billsDueTotal,
      availableByTier,
      netByTier,
      verdictByTier,
      defaultTier,
    }

    // ============================================================
    // triage: BillTriage — walk the in-window bills due_date ASC, remaining
    // ASC (the way a stack of bills actually gets worked), covering each
    // until the money runs out. Keeps walking past the first miss, since a
    // later, smaller bill may still fit.
    // ============================================================

    function toDecisionBill(b: ActiveBill): DecisionBill {
      return {
        id: b.id,
        name: b.name,
        vendorName: vendorNameOf(b.vendor),
        amount: Number(b.amount),
        amountPaid: Number(b.amount_paid),
        remaining: b.remaining,
        dueDate: b.due_date,
        isPastDue: b.due_date < today,
      }
    }

    const sortedForTriage = [...billsInWindow].sort((a, b) => {
      if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1
      return a.remaining - b.remaining
    })

    const triageAvailable = availableByTier[defaultTier]
    const covered: DecisionBill[] = []
    const notCovered: DecisionBill[] = []
    let runningCovered = 0
    for (const bill of sortedForTriage) {
      if (runningCovered + bill.remaining <= triageAvailable + 0.005) {
        covered.push(toDecisionBill(bill))
        runningCovered += bill.remaining
      } else {
        notCovered.push(toDecisionBill(bill))
      }
    }
    const coveredTotal = covered.reduce((sum, b) => sum + b.remaining, 0)
    const notCoveredTotal = notCovered.reduce((sum, b) => sum + b.remaining, 0)
    const leftover = triageAvailable - coveredTotal
    const shortfallOnNext = notCovered.length > 0 ? notCovered[0].remaining - leftover : null

    const triage: BillTriage = {
      tier: defaultTier,
      available: triageAvailable,
      covered,
      notCovered,
      coveredTotal,
      notCoveredTotal,
      leftover,
      shortfallOnNext,
    }

    // ============================================================
    // levers: Lever[] — only surfaced when the default tier is short.
    // ============================================================

    const defaultNet = netByTier[defaultTier]
    const levers: Lever[] = []
    if (defaultNet < 0) {
      const topBillCandidate = billsInWindow.reduce<ActiveBill | null>(
        (max, b) => (max === null || b.remaining > max.remaining ? b : max),
        null
      )

      const candidateLevers: Lever[] = []

      if (arOverdueAmount > 0) {
        const resultingNet = defaultNet + arOverdueAmount
        candidateLevers.push({
          key: 'collect_ar',
          label: 'Collect overdue receivables',
          detail: `${arOverdueCount} overdue invoice${arOverdueCount === 1 ? '' : 's'}, oldest ${arOverdueOldestDays} day${arOverdueOldestDays === 1 ? '' : 's'} overdue`,
          amount: arOverdueAmount,
          resultingNet,
          closesGap: resultingNet >= 0,
        })
      }

      if (topBillCandidate && topBillCandidate.remaining > 0) {
        const resultingNet = defaultNet + topBillCandidate.remaining
        candidateLevers.push({
          key: 'defer_top_bill',
          label: `Defer or payment-plan ${topBillCandidate.name}`,
          detail: `Due ${topBillCandidate.due_date}`,
          amount: topBillCandidate.remaining,
          resultingNet,
          closesGap: resultingNet >= 0,
        })
      }

      if (pendingAmount > 0) {
        const resultingNet = defaultNet + pendingAmount
        candidateLevers.push({
          key: 'confirm_pending',
          label: 'Confirm the pending orders',
          detail: `${pendingCount} pending order${pendingCount === 1 ? '' : 's'}`,
          amount: pendingAmount,
          resultingNet,
          closesGap: resultingNet >= 0,
        })
      }

      levers.push(...candidateLevers.sort((a, b) => b.amount - a.amount))
    }

    // ---- decisionGroups (Panel 1) ---------------------------------------
    const decisionBillsWindow = allActiveBills.filter((b) => b.due_date <= horizon14)

    const decisionBills: DecisionBill[] = decisionBillsWindow.map((b) => ({
      id: b.id,
      name: b.name,
      vendorName: vendorNameOf(b.vendor),
      amount: Number(b.amount),
      amountPaid: Number(b.amount_paid),
      remaining: b.remaining,
      dueDate: b.due_date,
      isPastDue: b.due_date < today,
    }))

    const groupMap = new Map<string, DecisionBill[]>()
    for (const db of decisionBills) {
      const key = `${db.name}::${db.dueDate}`
      const arr = groupMap.get(key)
      if (arr) arr.push(db)
      else groupMap.set(key, [db])
    }

    const decisionGroups: DecisionGroup[] = Array.from(groupMap.entries())
      .map(([key, bills]) => {
        const total = bills.reduce((sum, b) => sum + b.remaining, 0)
        const earliestDueDate = bills[0].dueDate
        return {
          key,
          label: bills[0].name,
          vendorName: bills[0].vendorName,
          isGroup: bills.length > 1,
          billCount: bills.length,
          total,
          earliestDueDate,
          isPastDue: earliestDueDate < today,
          bills,
        }
      })
      .sort((a, b) => {
        if (a.earliestDueDate !== b.earliestDueDate) return a.earliestDueDate < b.earliestDueDate ? -1 : 1
        return b.total - a.total
      })

    // ---- Exceptions #1 (past_due_unpaid) and #2 (stalled_partial) -------
    const pastDueCandidates = allActiveBills.filter((b) => b.due_date < today)
    const stalledCandidates = allActiveBills.filter((b) => b.status === 'partial')
    const relevantBillIds = Array.from(
      new Set([...pastDueCandidates.map((b) => b.id), ...stalledCandidates.map((b) => b.id)])
    )

    let relatedPayments: { bill_id: string; paid_date: string }[] = []
    if (relevantBillIds.length > 0) {
      const { data: paymentsData, error: paymentsError } = await supabase
        .from('finance_bill_payments')
        .select('bill_id, paid_date')
        .in('bill_id', relevantBillIds)
        .range(0, 4999)
      if (paymentsError) {
        console.error('getCashBoard: error fetching bill payments for exception groups:', paymentsError)
        return { success: false, error: paymentsError.message }
      }
      relatedPayments = paymentsData ?? []
    }

    const paymentCountByBill = new Map<string, number>()
    const mostRecentPaidByBill = new Map<string, string>()
    for (const p of relatedPayments) {
      paymentCountByBill.set(p.bill_id, (paymentCountByBill.get(p.bill_id) ?? 0) + 1)
      const prev = mostRecentPaidByBill.get(p.bill_id)
      if (!prev || p.paid_date > prev) mostRecentPaidByBill.set(p.bill_id, p.paid_date)
    }

    const pastDueUnpaidAll = pastDueCandidates
      .filter((b) => (paymentCountByBill.get(b.id) ?? 0) === 0)
      .map((b) => ({
        id: b.id,
        label: b.name,
        sublabel: vendorNameOf(b.vendor),
        amount: b.remaining,
        date: b.due_date,
        ageDays: daysBetween(b.due_date, today),
      }))
      .sort((a, b) => b.amount - a.amount)

    const stalledPartialAll = stalledCandidates
      .map((b) => {
        const mostRecent = mostRecentPaidByBill.get(b.id) ?? null
        return { bill: b, mostRecent }
      })
      .filter(({ mostRecent }) => mostRecent !== null && daysBetween(mostRecent, today) > 14)
      .map(({ bill, mostRecent }) => ({
        id: bill.id,
        label: bill.name,
        sublabel: vendorNameOf(bill.vendor),
        amount: bill.remaining,
        date: mostRecent as string,
        ageDays: daysBetween(mostRecent as string, today),
      }))
      .sort((a, b) => b.amount - a.amount)

    // ---- Exception #3 (paid_no_bank_trail) -------------------------------
    interface NoBankTrailRow {
      id: string
      amount: number
      paid_date: string
      payment_method: string
      bill: { name: string; vendor: VendorEmbed } | { name: string; vendor: VendorEmbed }[] | null
    }
    const noBankTrailRows = (noBankTrailRes.data ?? []) as unknown as NoBankTrailRow[]
    const paidNoBankTrailAll: ExceptionItem[] = noBankTrailRows
      .map((r) => {
        const billData = Array.isArray(r.bill) ? r.bill[0] : r.bill
        const billName = billData?.name ?? 'Unknown bill'
        const vendorName = vendorNameOf(billData?.vendor ?? null)
        return {
          id: r.id,
          label: vendorName ? `${billName} — ${vendorName}` : billName,
          sublabel: r.payment_method,
          amount: Number(r.amount),
          date: r.paid_date,
          ageDays: daysBetween(r.paid_date, today),
        }
      })
      .sort((a, b) => b.amount - a.amount)

    // ---- Exceptions #4 (money_out_no_bill) and #5 (recurring_unplanned) --
    // get_untracked_bank_transactions() has no date parameter and returns
    // every unreconciled outflow since banksync history began (2025-02-06
    // as of this writing — 249 rows >= $500). A worklist spanning 18+ months
    // is an archive, not something a human triages daily, so both exception
    // groups below are bounded to the same trailing-90-day window (`since90`,
    // already computed above for paid_no_bank_trail) — filtered here in TS
    // since the RPC itself can't take a date bound.
    const untrackedAll = (untrackedRes.error ? [] : (untrackedRes.data as RawBankTxn[] | null)) ?? []
    const untracked = untrackedAll.filter((t) => t.txn_date >= since90)

    const moneyOutNoBillAll: ExceptionItem[] = untracked
      .filter((t) => Math.abs(Number(t.amount)) >= 500)
      .map((t) => ({
        id: `bs-${t.bs_id}`,
        label: t.description,
        sublabel: t.merchant_name ?? t.category ?? null,
        amount: Math.abs(Number(t.amount)),
        date: t.txn_date,
        ageDays: daysBetween(t.txn_date, today),
      }))
      .sort((a, b) => b.amount - a.amount)

    // Checks are excluded from recurring_unplanned only (money_out_no_bill
    // above is untouched): a check is an individually-numbered one-off
    // payment instrument, not a recurring obligation — 30 different checks
    // to 30 different payees are not "a pattern," they're already correctly
    // surfaced individually in money_out_no_bill. Everything else is keyed
    // by recurringPatternKey(), which preserves the destination account
    // number for transfers (see that function's doc comment) instead of the
    // generic normalizeDescription() digit-stripping, which would otherwise
    // merge "transfer to payroll funding" and "transfer to management fee"
    // into one meaningless "TRANSFER FROM X TO X" bucket.
    const recurringGroups = new Map<string, RawBankTxn[]>()
    for (const t of untracked) {
      if (/CHECK\s*#/i.test(t.description)) continue
      const key = recurringPatternKey(t.description)
      const arr = recurringGroups.get(key)
      if (arr) arr.push(t)
      else recurringGroups.set(key, [t])
    }
    const recurringUnplannedAll: ExceptionItem[] = Array.from(recurringGroups.entries())
      .filter(([, txns]) => txns.length >= 3)
      .map(([pattern, txns]) => {
        const total = txns.reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0)
        const avg = total / txns.length
        const mostRecentDate = txns.reduce((max, t) => (t.txn_date > max ? t.txn_date : max), txns[0].txn_date)
        return {
          id: `recurring-${pattern}`,
          label: pattern,
          sublabel: `${txns.length} occurrences, avg ${formatMoney(avg)}`,
          amount: total,
          date: mostRecentDate,
          ageDays: daysBetween(mostRecentDate, today),
        }
      })
      .sort((a, b) => b.amount - a.amount)

    // ---- Assemble exceptions, capping items at 25/group ------------------
    function capGroup(
      kind: ExceptionGroup['kind'],
      title: string,
      baseDescription: string,
      items: ExceptionItem[]
    ): ExceptionGroup {
      const total = items.reduce((sum, i) => sum + i.amount, 0)
      const count = items.length
      const shown = items.slice(0, 25)
      const description =
        count > 25 ? `${baseDescription} (showing 25 of ${count})` : baseDescription
      return { kind, title, description, count, total, items: shown }
    }

    const exceptions: ExceptionGroup[] = [
      capGroup(
        'past_due_unpaid',
        'Past Due, Unpaid',
        'Bills past their due date with zero payments ever recorded against them.',
        pastDueUnpaidAll
      ),
      capGroup(
        'stalled_partial',
        'Stalled Partial Payments',
        'Partially paid bills whose most recent payment was more than 14 days ago.',
        stalledPartialAll
      ),
      capGroup(
        'paid_no_bank_trail',
        'Paid, No Bank Trail',
        'Payments recorded in the ledger (any method, including cash and ACH) in the last 90 days that have not been matched to a bank transaction.',
        paidNoBankTrailAll
      ),
      capGroup(
        'money_out_no_bill',
        'Money Out, No Bill',
        'Bank debits of $500 or more, last 90 days, with no bill on record.',
        moneyOutNoBillAll
      ),
      capGroup(
        'recurring_unplanned',
        'Recurring & Unplanned',
        'Untracked bank transactions (last 90 days) matching the same description pattern 3 or more times.',
        recurringUnplannedAll
      ),
    ]

    // ---- receivables (Panel 2) --------------------------------------------
    const receivableItems: ReceivableItem[] = receivableOrders.map((o) => {
      const customerData = Array.isArray(o.customers) ? o.customers[0] : o.customers
      const daysOverdue = o.terms_payment_date ? daysBetween(o.terms_payment_date, today) : -1
      let bucket: AgingBucket | 'not_due'
      if (daysOverdue <= 0) bucket = 'not_due'
      else if (daysOverdue <= 15) bucket = '0-15'
      else if (daysOverdue <= 30) bucket = '16-30'
      else bucket = '31+'
      return {
        orderId: o.id,
        orderNumber: o.order_number ?? '',
        customerName: customerData?.business_name ?? null,
        amount: Number(o.total_price ?? 0),
        deliveredAt: o.delivered_at,
        expectedDate: o.terms_payment_date,
        daysOverdue,
        bucket,
      }
    })

    // Always emit all three aging buckets, even when empty, so the UI has a
    // stable three-row shape (16-30 is legitimately empty on some days).
    const bucketOrder: AgingBucket[] = ['0-15', '16-30', '31+']
    const buckets = bucketOrder.map((label) => {
      const inBucket = receivableItems.filter((r) => r.bucket === label)
      return {
        label,
        count: inBucket.length,
        total: inBucket.reduce((sum, r) => sum + r.amount, 0),
      }
    })
    const total = buckets.reduce((sum, b) => sum + b.total, 0)
    const notYetDue = receivableItems
      .filter((r) => r.bucket === 'not_due')
      .reduce((sum, r) => sum + r.amount, 0)

    const receivables: ReceivablesPanel = {
      buckets,
      total,
      notYetDue,
      items: [...receivableItems].sort((a, b) => b.daysOverdue - a.daysOverdue),
    }

    // ---- inflowForecast (Panel 2) ------------------------------------------
    interface DeliveredOrderRow {
      id: string
      total_price: number | null
      delivered_at: string | null
    }
    const deliveredOrders = (deliveredRes.data ?? []) as DeliveredOrderRow[]

    const weeklyTotals = weeks.map(({ start, end }) =>
      deliveredOrders
        .filter((o) => {
          const d = (o.delivered_at ?? '').substring(0, 10)
          return d >= start && d <= end
        })
        .reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    )
    const sortedWeeklyTotals = [...weeklyTotals].sort((a, b) => a - b)

    interface PipelineOrderRow {
      id: string
      total_price: number | null
    }
    const pipelineOrders = (pipelineRes.data ?? []) as PipelineOrderRow[]
    const pipelineNow = pipelineOrders.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)

    const inflowForecast: InflowForecast = {
      conservativeWeekly: percentile(sortedWeeklyTotals, 25),
      medianWeekly: percentile(sortedWeeklyTotals, 50),
      pipelineNow,
      weeksSampled: weeks.length,
    }

    // ---- Assemble ----------------------------------------------------------
    const data: CashBoardData = {
      generatedAt: new Date().toISOString(),
      asOfDate,
      isStale,

      cashOnHand,
      cashSource,
      avgDailyOutflow,
      daysOfCashLeft,

      ledger,
      triage,
      levers,

      decisionGroups,
      receivables,
      inflowForecast,
      exceptions,
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('getCashBoard error:', error)
    return { success: false, error: errorMessage }
  }
}
