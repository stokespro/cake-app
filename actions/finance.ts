'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { requireFinance } from '@/lib/auth/session'
import { buildCashFlowBoth } from '@/lib/finance/cash-flow'
import { buildWeeklyBudget, computeWeekBoundaries } from '@/lib/finance/weekly-budget'
import { pullBankSync } from '@/lib/finance/banksync-pull'
import type { PullResult } from '@/lib/finance/banksync-pull'
import {
  validatePaymentInput,
  mapPaymentDbErrorCode,
  stripPaymentErrorPrefix,
  deriveBankConfirmedBillIds,
  BILL_OVERPAY_PREFIX,
} from '@/lib/finance/bill-payments'
import type { PaymentMethod, PaymentErrorCode } from '@/lib/finance/bill-payments'
import type {
  BillInput,
  OrderInput,
  SnapshotInput,
  CashFlowResult,
} from '@/lib/finance/cash-flow'
import type {
  WeeklyBillInput,
  WeekBucket,
  WeeklyBillItem,
  WeeklyBudgetResult,
} from '@/lib/finance/weekly-budget'

// ============================================================
// TYPES
// ============================================================

export interface Vendor {
  id: string
  name: string
  category: string | null
  contact_info: string | null
  notes: string | null
  is_active: boolean
  bank_keywords: string | null
  created_at: string
  updated_at: string
}

export interface BillTemplate {
  id: string
  vendor_id: string | null
  name: string
  amount: number | null
  is_amount_fixed: boolean
  due_day_of_month: number | null
  recurrence: string
  category: string | null
  is_active: boolean
  notes: string | null
  created_at: string
  updated_at: string
  vendor?: Pick<Vendor, 'id' | 'name'>
}

export type BillStatus = 'unpaid' | 'paid' | 'partial' | 'void'

export interface Bill {
  id: string
  template_id: string | null
  vendor_id: string | null
  name: string
  period_month: string   // 'YYYY-MM-01'
  amount: number
  due_date: string
  status: BillStatus
  amount_paid: number
  paid_date: string | null
  payment_method: string | null
  payment_ref: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  template?: Pick<BillTemplate, 'id' | 'name' | 'amount'>
  vendor?: Pick<Vendor, 'id' | 'name'>
}

// NOTE: PaymentMethod / PaymentErrorCode are deliberately NOT re-exported from
// this file. It carries 'use server', and Next.js registers EVERY export in a
// 'use server' module as a callable server action. A re-export of an imported
// type survives into that registration as `registerServerReference(PaymentMethod, ...)`,
// but types are erased at compile time — so the module threw
// `ReferenceError: PaymentMethod is not defined` at evaluation, killing every
// server action in this file and blanking the entire finance section in prod.
// Import these two types from '@/lib/finance/bill-payments' instead.
// (Type *declarations* like `export type BillStatus = ...` below are fine —
// only re-exports of imported bindings leak.)

/**
 * One row of the finance_bill_payments ledger (SPRO-82). `finance_bills`'
 * `status` / `amount_paid` / `paid_date` / `payment_method` / `payment_ref`
 * columns are derived FROM these rows by a DB trigger — see
 * supabase/migrations/20260805210000_bill_payments_ledger.sql section A3.
 */
export interface BillPayment {
  id: string
  bill_id: string
  amount: number
  paid_date: string
  payment_method: PaymentMethod
  payment_ref: string | null
  bank_bs_id: number | null
  source: 'manual' | 'bank_auto' | 'bank_manual'
  notes: string | null
  created_by: string | null
  created_at: string
}

export interface CashSnapshot {
  id: string
  snapshot_date: string
  cash_on_hand: number
  source: 'manual' | 'bank'
  notes: string | null
  recorded_by: string | null
  created_at: string
}

export interface BankBalanceSummary {
  current: number
  available: number
  pending: number
  as_of_date: string
  account_number: string
}

export interface MonthSummary {
  bills: Bill[]
  latestSnapshot: CashSnapshot | null
  realizedRevenue: number
  pipelineRevenue: number
  // Pipeline split — non-terms (confirmed/packed by requested_delivery_date)
  // and terms (confirmed/packed/delivered + unpaid by terms_payment_date).
  pipelineNonTerms: number
  pipelineTerms: number
  cashFlow: {
    realized: CashFlowResult
    withPipeline: CashFlowResult
  } | null
  // Populated from get_bank_balance() RPC (service_role call).
  // null when bank sync has not run or RPC errors — UI degrades gracefully.
  bankBalance: BankBalanceSummary | null
}

export interface WeeklySummary {
  weeks: WeekBucket[]
  unbucketedBills: WeeklyBillItem[]
  latestSnapshot: CashSnapshot | null
  bankBalance: BankBalanceSummary | null
  openingBalance: number
  snapshotDate: string
  conservativeTrough: number
  optimisticTrough: number
}

// ============================================================
// VENDORS
// ============================================================

export async function createVendor(input: {
  name: string
  category?: string
  contact_info?: string
  notes?: string
}): Promise<{ success: boolean; data?: Vendor; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from('finance_vendors')
      .insert({
        name: input.name.trim(),
        category: input.category?.trim() || null,
        contact_info: input.contact_info?.trim() || null,
        notes: input.notes?.trim() || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating vendor:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function updateVendor(
  id: string,
  input: {
    name?: string
    category?: string | null
    contact_info?: string | null
    notes?: string | null
    is_active?: boolean
    bank_keywords?: string | null
  }
): Promise<{ success: boolean; data?: Vendor; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (input.name !== undefined)          updateData.name = input.name.trim()
    if (input.category !== undefined)      updateData.category = input.category?.trim() || null
    if (input.contact_info !== undefined)  updateData.contact_info = input.contact_info?.trim() || null
    if (input.notes !== undefined)         updateData.notes = input.notes?.trim() || null
    if (input.is_active !== undefined)     updateData.is_active = input.is_active
    if (input.bank_keywords !== undefined) updateData.bank_keywords = input.bank_keywords?.trim() || null

    const { data, error } = await supabase
      .from('finance_vendors')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating vendor:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// BILL TEMPLATES
// ============================================================

export async function createBillTemplate(input: {
  vendor_id?: string
  name: string
  amount?: number
  is_amount_fixed?: boolean
  due_day_of_month?: number
  recurrence?: string
  category?: string
  notes?: string
}): Promise<{ success: boolean; data?: BillTemplate; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from('finance_bill_templates')
      .insert({
        vendor_id: input.vendor_id || null,
        name: input.name.trim(),
        amount: input.amount ?? null,
        is_amount_fixed: input.is_amount_fixed ?? true,
        due_day_of_month: input.due_day_of_month ?? null,
        recurrence: input.recurrence || 'monthly',
        category: input.category?.trim() || null,
        notes: input.notes?.trim() || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating bill template:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function updateBillTemplate(
  id: string,
  input: {
    vendor_id?: string | null
    name?: string
    amount?: number | null
    is_amount_fixed?: boolean
    due_day_of_month?: number | null
    recurrence?: string
    category?: string | null
    notes?: string | null
    is_active?: boolean
  }
): Promise<{ success: boolean; data?: BillTemplate; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (input.vendor_id !== undefined)       updateData.vendor_id = input.vendor_id
    if (input.name !== undefined)            updateData.name = input.name.trim()
    if (input.amount !== undefined)          updateData.amount = input.amount
    if (input.is_amount_fixed !== undefined) updateData.is_amount_fixed = input.is_amount_fixed
    if (input.due_day_of_month !== undefined) updateData.due_day_of_month = input.due_day_of_month
    if (input.recurrence !== undefined)      updateData.recurrence = input.recurrence
    if (input.category !== undefined)        updateData.category = input.category?.trim() || null
    if (input.notes !== undefined)           updateData.notes = input.notes?.trim() || null
    if (input.is_active !== undefined)       updateData.is_active = input.is_active

    const { data, error } = await supabase
      .from('finance_bill_templates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating bill template:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function deactivateBillTemplate(id: string): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { error } = await supabase
      .from('finance_bill_templates')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      console.error('Error deactivating bill template:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// BILL INSTANTIATION
// ============================================================

/**
 * Instantiate bills from all active templates for a given month.
 * Idempotent: skips any template that already has a bill for this period_month.
 *
 * @param month  'YYYY-MM-01' — always the first of the month
 */
export async function instantiateBillsFromTemplates(month: string): Promise<{
  success: boolean
  created: number
  skipped: number
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, created: 0, skipped: 0, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Fetch all active templates with their vendor
    const { data: templates, error: templatesError } = await supabase
      .from('finance_bill_templates')
      .select('*, vendor:finance_vendors(id, name)')
      .eq('is_active', true)

    if (templatesError) {
      console.error('Error fetching bill templates:', templatesError)
      return { success: false, created: 0, skipped: 0, error: templatesError.message }
    }

    if (!templates || templates.length === 0) {
      return { success: true, created: 0, skipped: 0 }
    }

    // Find which templates already have a bill for this period
    const { data: existingBills, error: existingError } = await supabase
      .from('finance_bills')
      .select('template_id')
      .eq('period_month', month)
      .not('template_id', 'is', null)

    if (existingError) {
      console.error('Error checking existing bills:', existingError)
      return { success: false, created: 0, skipped: 0, error: existingError.message }
    }

    const existingTemplateIds = new Set(
      (existingBills || []).map((b) => b.template_id as string)
    )

    let created = 0
    let skipped = 0

    for (const template of templates) {
      if (existingTemplateIds.has(template.id)) {
        skipped++
        continue
      }

      // Compute due_date from due_day_of_month within the period month
      const dueDate = computeDueDate(month, template.due_day_of_month)

      const { error: insertError } = await supabase
        .from('finance_bills')
        .insert({
          template_id: template.id,
          vendor_id: template.vendor_id || null,
          name: template.name,
          period_month: month,
          // If amount is not fixed, use 0 as placeholder (user updates before due date)
          amount: template.is_amount_fixed && template.amount != null ? template.amount : 0,
          due_date: dueDate,
          status: 'unpaid',
          amount_paid: 0,
        })

      if (insertError) {
        console.error(`Error instantiating bill for template ${template.id}:`, insertError)
        // Continue with other templates rather than aborting
      } else {
        created++
      }
    }

    return { success: true, created, skipped }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, created: 0, skipped: 0, error: errorMessage }
  }
}

/**
 * Derive period_month ('YYYY-MM-01') from a due_date string ('YYYY-MM-DD').
 * Uses string slicing — not new Date() — to avoid timezone shift bugs.
 */
function derivePeriodMonth(dueDate: string): string {
  // dueDate is 'YYYY-MM-DD'; take the first 7 chars and append '-01'
  return dueDate.substring(0, 7) + '-01'
}

/**
 * Compute a due date within the given month from a day-of-month integer.
 * Clamps to the last day of the month if due_day_of_month exceeds it (e.g. 31 in Feb).
 * Falls back to the last day of the month when due_day_of_month is null.
 */
function computeDueDate(periodMonth: string, dueDayOfMonth: number | null): string {
  // periodMonth is 'YYYY-MM-01'
  const [year, month] = periodMonth.split('-').map(Number)
  const lastDay = new Date(year, month, 0).getDate() // 0th day of next month = last day of this month
  const day = dueDayOfMonth ? Math.min(dueDayOfMonth, lastDay) : lastDay
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ============================================================
// BILLS
// ============================================================

/**
 * Creates a bill. SPRO-82: `status`/`amount_paid`/`paid_date`/`payment_method`/
 * `payment_ref` on `finance_bills` are now derived-by-trigger columns, so a
 * bill created "already paid" (e.g. from the create-from-bank-expense flow,
 * SPRO-77) is written as two steps — insert the bill unpaid, then insert a
 * `finance_bill_payments` row via recordBillPayment() — instead of writing
 * amount_paid/status directly. The input signature is unchanged so
 * createBillFromBankTransaction() (bank.ts) keeps working untouched.
 */
export async function createBill(input: {
  template_id?: string
  vendor_id?: string
  name: string
  /** @deprecated period_month is now derived from due_date server-side and ignored */
  period_month?: string
  amount: number
  due_date: string
  status?: BillStatus
  payment_method?: string | null
  payment_ref?: string | null
  paid_date?: string | null
  amount_paid?: number | null
  notes?: string
  // FIX 5 (SPRO-82 adversarial review): `created_by` is deliberately NOT part
  // of this input — it must always come from the server-verified session
  // (auth.session.userId below), never from the client. Every caller
  // (bills/page.tsx, bank.ts's createBillFromBankTransaction) is already
  // requireFinance()-gated, so the old client-supplied `created_by` was
  // attribution risk rather than an access-control hole, but there is no
  // reason to accept it from the client at all when the server already knows
  // who is calling.
}): Promise<{ success: boolean; data?: Bill; error?: string; errorCode?: PaymentErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  const status = input.status || 'unpaid'
  const hasPayment = status === 'paid' || status === 'partial'

  // Full amount for 'paid'; caller-provided amount for 'partial'. Validate
  // BEFORE writing anything so a bad payment never leaves an orphan bill —
  // 'unpaid' bill amount here is fine since a brand-new bill has no other
  // payments yet (existingPaymentsTotal: 0).
  const paymentAmount = status === 'paid' ? input.amount : (input.amount_paid ?? 0)
  if (hasPayment) {
    const validation = validatePaymentInput(
      { amount: paymentAmount, payment_method: input.payment_method, payment_ref: input.payment_ref },
      { billAmount: input.amount, billStatus: 'unpaid', existingPaymentsTotal: 0 }
    )
    if (!validation.valid) {
      return { success: false, error: stripPaymentErrorPrefix(validation.error), errorCode: validation.errorCode }
    }
  }

  try {
    const supabase = await createServiceClient()

    // Always derive period_month from due_date so it tracks the correct calendar
    // month regardless of which UI month tab was active when the bill was created.
    const periodMonth = derivePeriodMonth(input.due_date)

    const { data: newBill, error: billError } = await supabase
      .from('finance_bills')
      .insert({
        template_id: input.template_id || null,
        vendor_id: input.vendor_id || null,
        name: input.name.trim(),
        period_month: periodMonth,
        amount: input.amount,
        due_date: input.due_date,
        status: 'unpaid',
        amount_paid: 0,
        notes: input.notes?.trim() || null,
        created_by: auth.session.userId,
      })
      .select()
      .single()

    if (billError || !newBill) {
      console.error('Error creating bill:', billError)
      return { success: false, error: billError?.message ?? 'Failed to create bill' }
    }

    if (!hasPayment) {
      return { success: true, data: newBill as Bill }
    }

    const paymentResult = await recordBillPayment({
      bill_id: newBill.id,
      amount: paymentAmount,
      paid_date: input.paid_date || new Date().toISOString().substring(0, 10),
      payment_method: (input.payment_method?.trim() as PaymentMethod),
      payment_ref: input.payment_ref?.trim() || null,
    })

    if (!paymentResult.success) {
      // Keep the bill — it's the user's data, and re-entering it is worse
      // than an unpaid bill sitting around. Mirrors
      // createBillFromBankTransaction()'s own "keep the bill, warn about the
      // rest" precedent (bank.ts).
      return {
        success: false,
        error: paymentResult.error ? stripPaymentErrorPrefix(paymentResult.error) : paymentResult.error,
        errorCode: paymentResult.errorCode,
        data: newBill as Bill,
      }
    }

    // Re-fetch so the trigger-derived amount_paid/status/paid_date/etc. on
    // the returned Bill reflect the payment that was just recorded.
    const { data: finalBill, error: refetchError } = await supabase
      .from('finance_bills')
      .select()
      .eq('id', newBill.id)
      .single()

    if (refetchError || !finalBill) {
      console.error('Error refetching bill after payment:', refetchError)
      return { success: true, data: newBill as Bill }
    }

    return { success: true, data: finalBill as Bill }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Updates a bill's non-payment fields. SPRO-82 breaking change: this no
 * longer accepts `status` / `amount_paid` / `paid_date` / `payment_method` /
 * `payment_ref` — those are derived from `finance_bill_payments` by a DB
 * trigger now. Use recordBillPayment() / updateBillPayment() /
 * deleteBillPayment() to change payments, and setBillVoid() to void/un-void.
 */
export async function updateBill(
  id: string,
  input: {
    name?: string
    amount?: number
    due_date?: string
    notes?: string | null
    vendor_id?: string | null
    planned_pay_date?: string | null
  }
): Promise<{ success: boolean; data?: Bill; error?: string; errorCode?: PaymentErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Reducing the amount below what's already been paid would leave the
    // ledger in an inconsistent state (overpaid relative to the new amount).
    // This is the "edit the bill amount" escape hatch the overpay guard
    // (spec A2) points users at — it must not itself be usable to create the
    // very state it exists to prevent.
    if (input.amount !== undefined) {
      const { data: current, error: fetchError } = await supabase
        .from('finance_bills')
        .select('amount_paid')
        .eq('id', id)
        .single()

      if (fetchError || !current) {
        return { success: false, error: fetchError?.message ?? 'Bill not found', errorCode: 'not_found' }
      }

      const amountPaid = Number(current.amount_paid)
      if (input.amount < amountPaid) {
        return {
          success: false,
          errorCode: 'would_overpay',
          // No DB trigger covers this case (fn_finance_bill_payments_guard_overpay
          // only fires on finance_bill_payments writes, not on finance_bills.amount
          // updates) — this is the sole enforcement point for it, per spec B1's
          // "Guard: reducing amount below the sum of existing payments" bullet.
          // Uses the BILL_OVERPAY_PREFIX constant for consistency with the DB's
          // own prefix even though the message text itself is TS-only — then
          // stripped immediately below before it reaches the caller, exactly
          // like every other payment-error return path in this file.
          error: stripPaymentErrorPrefix(
            `${BILL_OVERPAY_PREFIX} Cannot reduce the bill amount to ${input.amount.toFixed(2)} — payments already ` +
              `total ${amountPaid.toFixed(2)}. Delete or reduce a payment first.`
          ),
        }
      }
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (input.name !== undefined)           updateData.name = input.name.trim()
    if (input.due_date !== undefined) {
      updateData.due_date = input.due_date
      // Keep period_month in sync: a changed due_date moves the bill to the correct month bucket.
      updateData.period_month = derivePeriodMonth(input.due_date)
    }
    if (input.notes !== undefined)          updateData.notes = input.notes?.trim() || null
    if (input.vendor_id !== undefined)      updateData.vendor_id = input.vendor_id
    // planned_pay_date: setting to null clears the planned date (marks as unplanned).
    if (input.planned_pay_date !== undefined) updateData.planned_pay_date = input.planned_pay_date
    if (input.amount !== undefined)         updateData.amount = input.amount

    const { data, error } = await supabase
      .from('finance_bills')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating bill:', error)
      // FIX 7 (SPRO-82 adversarial review, found in parallel by the SQL
      // agent): a new DB trigger, trg_finance_bills_guard_amount_reduction
      // (BEFORE UPDATE OF amount ON finance_bills), is the race-proof
      // backstop for the TOCTOU window in the read-then-write amount-
      // reduction check above — two concurrent updateBill() calls can both
      // pass that read-then-write check before either write lands. When the
      // trigger fires it raises the same 'BILL_OVERPAY:' prefixed message
      // this file's other payment-error paths already know how to classify,
      // so it must be routed through the same mapping/stripping pair rather
      // than returned as a raw error string — otherwise the sentinel prefix
      // leaks to the user's screen and errorCode stays undefined instead of
      // 'would_overpay'.
      return {
        success: false,
        error: stripPaymentErrorPrefix(error.message),
        errorCode: mapPaymentDbErrorCode(error.message),
      }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Voids or un-voids a bill (SPRO-82) — the path that replaces setting
 * `status: 'void'` through updateBill(), which no longer accepts status.
 *
 * Un-voiding does NOT force status back to 'unpaid': while a bill is void,
 * recompute_bill_totals() never touches its derived columns (spec A3) and
 * the overpay guard refuses any new payment against a void bill (spec A2,
 * 'BILL_VOID:' prefix), so `amount_paid` on the row is still an accurate
 * reflection of whatever was recorded before it was voided. Restoring the
 * status that figure implies (unpaid/partial/paid) avoids silently losing a
 * bill that was paid before it got voided.
 */
export async function setBillVoid(
  billId: string,
  isVoid: boolean
): Promise<{ success: boolean; data?: Bill; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    let nextStatus: BillStatus = 'void'

    if (!isVoid) {
      const { data: current, error: fetchError } = await supabase
        .from('finance_bills')
        .select('amount, amount_paid')
        .eq('id', billId)
        .single()

      if (fetchError || !current) {
        return { success: false, error: fetchError?.message ?? 'Bill not found' }
      }

      const amountPaid = Number(current.amount_paid)
      const amount = Number(current.amount)
      nextStatus = amountPaid <= 0 ? 'unpaid' : amountPaid >= amount ? 'paid' : 'partial'
    }

    const { data, error } = await supabase
      .from('finance_bills')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('id', billId)
      .select()
      .single()

    if (error) {
      console.error('Error setting bill void state:', error)
      return { success: false, error: error.message }
    }

    revalidatePath('/dashboard/finance/bills')
    revalidatePath('/dashboard/finance')

    return { success: true, data: data as Bill }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// BILL PAYMENTS (finance_bill_payments ledger — SPRO-82)
// ============================================================
// A bill can now hold several payments — see
// supabase/migrations/20260805210000_bill_payments_ledger.sql. The DB
// trigger there (fn_finance_bill_payments_recompute /
// recompute_bill_totals) keeps finance_bills.amount_paid/status/paid_date/
// payment_method/payment_ref in sync from these rows on every insert/update/
// delete, so getBillsForMonth/getMonthSummary/getWeeklyBudget need no
// changes — they just keep reading finance_bills as before.
//
// The overpay guard (fn_finance_bill_payments_guard_overpay, spec A2) is the
// actual authority and runs under a row lock on the parent bill, so it is
// race-proof against concurrent inserts in a way validatePaymentInput()'s
// pre-check here cannot be. mapPaymentDbErrorCode() below reads the guard's
// own 'BILL_OVERPAY:'/'BILL_VOID:' message prefixes so a race that the
// pre-check missed still surfaces the correct errorCode to the caller.

/**
 * All payments recorded against a bill, most recent paid_date first.
 */
export async function getBillPayments(billId: string): Promise<{
  success: boolean
  data?: BillPayment[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from('finance_bill_payments')
      .select('*')
      .eq('bill_id', billId)
      .order('paid_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching bill payments:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: (data ?? []) as BillPayment[] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Internal write path shared by recordBillPayment() (the client-facing
 * "manual" path) and applyReconciledBillPayment() (the bank-reconciliation
 * path used only by app/dashboard/finance/_actions/bank.ts). NOT exported —
 * `bank_bs_id`/`source` must never be reachable from the client-facing
 * recordBillPayment() input (FIX 1, SPRO-82 adversarial review), and keeping
 * this function un-exported is what enforces that at the type level: the
 * only two ways money can be linked to a bank transaction are (a) this
 * module's own recordBillPayment(), which always passes bank_bs_id: null,
 * source: 'manual', or (b) applyReconciledBillPayment() below, which is
 * still requireFinance()-gated and only ever called with a bank_bs_id that
 * bank.ts read from a server-verified finance_reconciliation_log row — never
 * from raw client input.
 *
 * FIX 2 (double-Confirm race): when `bank_bs_id` is provided, this first
 * looks for an existing finance_bill_payments row already linked to that
 * (bank_bs_id, bill_id) pair — the partial unique index uidx_fbp_bank_bill
 * enforces at most one such row — and updates it in place instead of
 * inserting a second one. supabase-js's `.upsert({ onConflict })` cannot be
 * used to do this atomically here: Postgres only infers a PARTIAL unique
 * index (`... WHERE bank_bs_id IS NOT NULL`) as an ON CONFLICT target when
 * the INSERT statement itself repeats that exact WHERE predicate, and
 * PostgREST/supabase-js's `onConflict` option only accepts a column list, not
 * a predicate — so an `.upsert()` here would silently fail to match the
 * index and either error or (worse) insert a duplicate anyway. This
 * select-then-update-or-insert is therefore an explicit, best-effort
 * narrowing of the race window, not a fully atomic guarantee — the DB
 * trigger + unique index remain the actual authority, same caveat
 * validatePaymentInput()'s doc comment already calls out for the overpay
 * check.
 */
async function insertBillPayment(input: {
  bill_id: string
  amount: number
  paid_date: string
  payment_method: PaymentMethod
  payment_ref?: string | null
  notes?: string | null
  created_by: string | null
  bank_bs_id: number | null
  source: 'manual' | 'bank_auto' | 'bank_manual'
}): Promise<{ success: boolean; data?: BillPayment; error?: string; errorCode?: PaymentErrorCode }> {
  const supabase = await createServiceClient()

  const { data: bill, error: billError } = await supabase
    .from('finance_bills')
    .select('amount, amount_paid, status')
    .eq('id', input.bill_id)
    .single()

  if (billError || !bill) {
    return { success: false, error: billError?.message ?? 'Bill not found', errorCode: 'not_found' }
  }

  // FIX 2: only relevant when this write targets a specific bank
  // transaction — manual payments (bank_bs_id null) have no uniqueness
  // constraint to reconcile against (uidx_fbp_bank_bill is a partial index,
  // WHERE bank_bs_id IS NOT NULL) and always insert fresh.
  let existingId: string | null = null
  let existingAmount = 0
  if (input.bank_bs_id != null) {
    const { data: existing, error: existingError } = await supabase
      .from('finance_bill_payments')
      .select('id, amount')
      .eq('bank_bs_id', input.bank_bs_id)
      .eq('bill_id', input.bill_id)
      .maybeSingle()

    if (existingError) {
      console.error('insertBillPayment: error checking existing bank-linked payment:', existingError)
      return { success: false, error: existingError.message }
    }
    if (existing) {
      existingId = existing.id
      existingAmount = Number(existing.amount)
    }
  }

  // Sum of every OTHER payment on the bill — excludes the row we're about to
  // update in place, mirroring updateBillPayment()'s own existingPaymentsTotal
  // math below.
  const existingPaymentsTotal = Number(bill.amount_paid) - existingAmount

  const validation = validatePaymentInput(
    { amount: input.amount, payment_method: input.payment_method, payment_ref: input.payment_ref },
    {
      billAmount: Number(bill.amount),
      billStatus: bill.status as BillStatus,
      existingPaymentsTotal,
    }
  )
  if (!validation.valid) {
    return { success: false, error: stripPaymentErrorPrefix(validation.error), errorCode: validation.errorCode }
  }

  if (existingId) {
    const { data, error } = await supabase
      .from('finance_bill_payments')
      .update({
        amount: input.amount,
        paid_date: input.paid_date,
        payment_method: input.payment_method,
        payment_ref: input.payment_ref?.trim() || null,
        notes: input.notes?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingId)
      .select()
      .single()

    if (error) {
      console.error('insertBillPayment: error updating existing bank-linked payment:', error)
      return {
        success: false,
        error: stripPaymentErrorPrefix(error.message),
        errorCode: mapPaymentDbErrorCode(error.message),
      }
    }
    return { success: true, data: data as BillPayment }
  }

  const { data, error } = await supabase
    .from('finance_bill_payments')
    .insert({
      bill_id: input.bill_id,
      amount: input.amount,
      paid_date: input.paid_date,
      payment_method: input.payment_method,
      payment_ref: input.payment_ref?.trim() || null,
      notes: input.notes?.trim() || null,
      bank_bs_id: input.bank_bs_id,
      source: input.source,
      created_by: input.created_by,
    })
    .select()
    .single()

  if (error) {
    console.error('Error recording bill payment:', error)
    return {
      success: false,
      error: stripPaymentErrorPrefix(error.message),
      errorCode: mapPaymentDbErrorCode(error.message),
    }
  }

  return { success: true, data: data as BillPayment }
}

/**
 * Records a new payment against a bill. `created_by` always comes from the
 * server-verified session (`auth.session.userId`) — never from the client.
 * `source` is always 'manual' and `bank_bs_id` is always null here; those two
 * fields are deliberately absent from this function's client-facing input
 * type (FIX 1, SPRO-82 adversarial review) — a client must not be able to
 * forge a bank linkage. 'bank_auto' rows are written only by the SQL
 * reconciliation functions (spec A6); 'bank_manual' rows are written only by
 * applyReconciledBillPayment() below (bank.ts's Confirm flow) and the
 * assign_reconciliation_match() RPC (spec A5) — never by this function.
 */
export async function recordBillPayment(input: {
  bill_id: string
  amount: number
  paid_date: string
  payment_method: PaymentMethod
  payment_ref?: string | null
  notes?: string | null
}): Promise<{ success: boolean; data?: BillPayment; error?: string; errorCode?: PaymentErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const result = await insertBillPayment({
      bill_id: input.bill_id,
      amount: input.amount,
      paid_date: input.paid_date,
      payment_method: input.payment_method,
      payment_ref: input.payment_ref,
      notes: input.notes,
      created_by: auth.session.userId,
      bank_bs_id: null,
      source: 'manual',
    })

    if (!result.success) return result

    revalidatePath('/dashboard/finance/bills')
    revalidatePath('/dashboard/finance')

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * FIX 1 (SPRO-82 adversarial review): records a bank-linked ('bank_manual')
 * payment against a bill, stamping `bank_bs_id` so the payment immediately
 * shows as reconciled rather than sitting in "Payments Awaiting Bank Match"
 * forever. Used ONLY by app/dashboard/finance/_actions/bank.ts's
 * confirmReconciliationMatch() (the "Confirm" button — the everyday
 * reconciliation path). The `assign_reconciliation_match()` RPC (spec A5,
 * the "Not the right bill?" path) writes the equivalent row directly in SQL
 * and does not go through this function.
 *
 * `bank_bs_id` here always originates from a server-verified
 * finance_reconciliation_log row read by bank.ts — never from raw client
 * input — so this is safe to keep as a distinct exported action rather than
 * folding it into recordBillPayment()'s client-facing surface. Still
 * requireFinance()-gated, same trust model as every other action in this
 * file (there is no RLS backstop; requireFinance() is the only gate).
 */
export async function applyReconciledBillPayment(input: {
  bill_id: string
  amount: number
  paid_date: string
  payment_method: PaymentMethod
  bank_bs_id: number
}): Promise<{ success: boolean; data?: BillPayment; error?: string; errorCode?: PaymentErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const result = await insertBillPayment({
      bill_id: input.bill_id,
      amount: input.amount,
      paid_date: input.paid_date,
      payment_method: input.payment_method,
      payment_ref: null,
      notes: null,
      created_by: auth.session.userId,
      bank_bs_id: input.bank_bs_id,
      source: 'bank_manual',
    })

    if (!result.success) return result

    revalidatePath('/dashboard/finance/bills')
    revalidatePath('/dashboard/finance')

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Edits an existing payment (amount, date, method, ref, notes). The overpay
 * check excludes the payment being edited from `existingPaymentsTotal` so
 * editing a payment's own amount up to the bill's remaining balance is
 * allowed.
 */
export async function updateBillPayment(
  paymentId: string,
  input: Partial<{
    amount: number
    paid_date: string
    payment_method: PaymentMethod
    payment_ref: string | null
    notes: string | null
  }>
): Promise<{ success: boolean; error?: string; errorCode?: PaymentErrorCode }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data: payment, error: paymentError } = await supabase
      .from('finance_bill_payments')
      .select('id, bill_id, amount, payment_method, payment_ref')
      .eq('id', paymentId)
      .single()

    if (paymentError || !payment) {
      return { success: false, error: paymentError?.message ?? 'Payment not found', errorCode: 'not_found' }
    }

    const { data: bill, error: billError } = await supabase
      .from('finance_bills')
      .select('amount, amount_paid, status')
      .eq('id', payment.bill_id)
      .single()

    if (billError || !bill) {
      return { success: false, error: billError?.message ?? 'Bill not found', errorCode: 'not_found' }
    }

    const candidateAmount = input.amount ?? Number(payment.amount)
    const candidateMethod = input.payment_method ?? (payment.payment_method as PaymentMethod)
    const candidateRef = input.payment_ref !== undefined ? input.payment_ref : payment.payment_ref

    // Sum of every OTHER payment on this bill — the bill's current
    // amount_paid (itself the trigger-maintained sum of ALL payments) minus
    // this payment's own current amount.
    const existingPaymentsTotal = Number(bill.amount_paid) - Number(payment.amount)

    const validation = validatePaymentInput(
      { amount: candidateAmount, payment_method: candidateMethod, payment_ref: candidateRef },
      {
        billAmount: Number(bill.amount),
        billStatus: bill.status as BillStatus,
        existingPaymentsTotal,
      }
    )
    if (!validation.valid) {
      return { success: false, error: stripPaymentErrorPrefix(validation.error), errorCode: validation.errorCode }
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.amount !== undefined)         updateData.amount = input.amount
    if (input.paid_date !== undefined)      updateData.paid_date = input.paid_date
    if (input.payment_method !== undefined) updateData.payment_method = input.payment_method
    if (input.payment_ref !== undefined)    updateData.payment_ref = input.payment_ref?.trim() || null
    if (input.notes !== undefined)          updateData.notes = input.notes?.trim() || null

    const { error } = await supabase
      .from('finance_bill_payments')
      .update(updateData)
      .eq('id', paymentId)

    if (error) {
      console.error('Error updating bill payment:', error)
      return {
        success: false,
        error: stripPaymentErrorPrefix(error.message),
        errorCode: mapPaymentDbErrorCode(error.message),
      }
    }

    revalidatePath('/dashboard/finance/bills')
    revalidatePath('/dashboard/finance')

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Deletes a payment. Never causes an overpay (removing money only reduces
 * the bill's total), so there is no validation step beyond the guard.
 */
export async function deleteBillPayment(paymentId: string): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { error } = await supabase
      .from('finance_bill_payments')
      .delete()
      .eq('id', paymentId)

    if (error) {
      console.error('Error deleting bill payment:', error)
      return { success: false, error: error.message }
    }

    revalidatePath('/dashboard/finance/bills')
    revalidatePath('/dashboard/finance')

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// FIX 6 (SPRO-82 adversarial review): markBillPaid() had zero remaining
// callers (verified with `grep -rn markBillPaid` across the repo — bank.ts
// does not import it, contrary to what an earlier comment here claimed) and
// has been removed rather than left as an untested money-writing path.
// recordBillPayment() / applyReconciledBillPayment() cover its old callers.

export async function deleteBill(billId: string): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // finance_reconciliation_log.bill_id has ON DELETE SET NULL, so deleting
    // a reconciled bill is safe — the reconciliation log rows are preserved
    // with bill_id set to null.
    const { error } = await supabase
      .from('finance_bills')
      .delete()
      .eq('id', billId)

    if (error) {
      console.error('Error deleting bill:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// CASH SNAPSHOTS
// ============================================================

export async function recordCashSnapshot(input: {
  snapshot_date: string
  cash_on_hand: number
  notes?: string
  recorded_by?: string
}): Promise<{ success: boolean; data?: CashSnapshot; error?: string }> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from('finance_cash_snapshots')
      .insert({
        snapshot_date: input.snapshot_date,
        cash_on_hand: input.cash_on_hand,
        notes: input.notes?.trim() || null,
        recorded_by: input.recorded_by || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error recording cash snapshot:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// MONTH SUMMARY (main read action)
// ============================================================

/**
 * Returns all data needed to render the Finance Overview for a given month,
 * including bills, revenue, the latest cash snapshot, and the computed
 * cash-flow projections (with/without pipeline).
 *
 * @param month  'YYYY-MM-01' — the first of the month to display
 */
export async function getMonthSummary(month: string): Promise<{
  success: boolean
  data?: MonthSummary
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const today = new Date().toISOString().substring(0, 10)
    const nextMonth = incrementMonth(month)

    // Fetch bills, snapshots, orders, and bank balance in parallel.
    // Bank balance uses the service-role client (service_role-only RPC).
    // It is fetched here for display purposes only — the cash-flow engine
    // anchors on cash_on_hand from the snapshot (already written by cron).
    // If the bank RPC fails we degrade gracefully (bankBalance = null).
    const [billsRes, snapshotsRes, ordersRes, bankBalanceRes] = await Promise.all([
      supabase
        .from('finance_bills')
        .select(`
          *,
          payment_method,
          template:finance_bill_templates(id, name, amount),
          vendor:finance_vendors(id, name)
        `)
        .eq('period_month', month)
        .order('due_date', { ascending: true }),

      supabase
        .from('finance_cash_snapshots')
        .select('*')
        .lte('snapshot_date', today)
        .order('snapshot_date', { ascending: false })
        .limit(1),

      // Month-scoped: terms-aware 4-branch filter.
      // Branch 1: non-terms delivered — realized by delivered_at
      // Branch 2: terms delivered + paid — realized by terms_paid_at
      // Branch 3: non-terms confirmed/packed — pipeline by requested_delivery_date
      // Branch 4: terms confirmed/packed/delivered + unpaid — pipeline by terms_payment_date
      //   (relaxed from delivered-only so pre-delivery terms orders count in pipeline)
      // Joins order_items for HYBRID revenue rule (line items when present,
      // else fall back to orders.total_price for legacy header-only orders).
      supabase
        .from('orders')
        .select(`
          id, order_number, status, total_price, delivered_at, requested_delivery_date,
          payment_terms, terms_payment_date, terms_paid_at,
          customers(business_name),
          order_items(line_total)
        `)
        .or(
          `and(status.eq.delivered,payment_terms.eq.false,delivered_at.gte.${month},delivered_at.lt.${nextMonth}),` +
          `and(status.eq.delivered,payment_terms.eq.true,terms_paid_at.gte.${month},terms_paid_at.lt.${nextMonth}),` +
          `and(status.in.(confirmed,packed),payment_terms.eq.false,requested_delivery_date.gte.${month},requested_delivery_date.lt.${nextMonth}),` +
          `and(status.in.(confirmed,packed,delivered),payment_terms.eq.true,terms_paid_at.is.null,terms_payment_date.gte.${month},terms_payment_date.lt.${nextMonth})`
        )
        .order('requested_delivery_date', { ascending: true })
        .range(0, 4999),

      // Non-fatal: catch so a bank RPC error doesn't block the whole page.
      createServiceClient()
        .then((svc) => svc.rpc('get_bank_balance'))
        .catch((err) => {
          // Non-fatal — a bank RPC failure shouldn't block the whole page, but
          // the failure must still be visible for debugging rather than
          // silently masqueraded as "no bank balance configured".
          console.error('Error fetching bank balance:', err)
          return { data: null, error: err instanceof Error ? err : new Error(String(err)) }
        }),
    ])

    if (billsRes.error) {
      console.error('Error fetching bills:', billsRes.error)
      return { success: false, error: billsRes.error.message }
    }
    if (snapshotsRes.error) {
      console.error('Error fetching cash snapshots:', snapshotsRes.error)
      return { success: false, error: snapshotsRes.error.message }
    }
    if (ordersRes.error) {
      console.error('Error fetching orders:', ordersRes.error)
      return { success: false, error: ordersRes.error.message }
    }

    const bills = billsRes.data
    const latestSnapshot = snapshotsRes.data?.[0] ?? null
    const ordersData = ordersRes.data

    // FIX 3 (SPRO-82 adversarial review): derive bank_confirmed from the
    // PAYMENT ledger (finance_bill_payments), not from
    // finance_reconciliation_log rows keyed to the whole bill — a bill can
    // now hold several check payments, and the old bill-scoped derivation
    // went true off ANY confirmed/auto_applied log row for the bill, hiding
    // a second still-uncleared check payment from the outflow projection.
    // See deriveBankConfirmedBillIds()'s own doc comment for the full
    // rationale, including why this is deliberately conservative (a bill
    // with any uncleared check payment stays in the projection in full).
    // Non-fatal on error: bank_confirmed defaults to false, uncleared checks
    // stay reserved (the safe direction).
    let confirmedBillIds = new Set<string>()
    try {
      const { data: checkPayments } = await supabase
        .from('finance_bill_payments')
        .select('bill_id, bank_bs_id')
        .eq('payment_method', 'check')
      if (checkPayments) {
        confirmedBillIds = deriveBankConfirmedBillIds(checkPayments)
      }
    } catch {
      // non-fatal — bank_confirmed defaults to false, uncleared checks stay reserved
    }

    // Resolve bank balance — gracefully null on any error
    let bankBalance: BankBalanceSummary | null = null
    if (bankBalanceRes.data && !bankBalanceRes.error) {
      const row = Array.isArray(bankBalanceRes.data)
        ? bankBalanceRes.data[0]
        : bankBalanceRes.data
      if (row) {
        bankBalance = {
          current:        Number(row.current_balance),
          available:      Number(row.available_balance),
          pending:        Number(row.pending_balance),
          as_of_date:     String(row.as_of_date),
          account_number: String(row.account_number),
        }
      }
    }

    // Compute realized and pipeline revenue — HYBRID rule:
    // use SUM(order_items.line_total) when the order has items, else fall back
    // to orders.total_price (preserves $176,940 of legacy header-only orders).
    // Terms orders: realized on terms_paid_at; pipeline on terms_payment_date until paid.
    let realizedRevenue = 0
    let pipelineNonTerms = 0
    let pipelineTerms = 0

    const orderInputs: OrderInput[] = []

    for (const order of ordersData || []) {
      // Supabase may return joined customer as an array or object
      const customer = Array.isArray(order.customers)
        ? order.customers[0]
        : order.customers
      const customerName = customer?.business_name ?? 'Unknown'

      const items = (order.order_items ?? []) as { line_total: number | null }[]
      const itemsTotal = items.reduce((s, i) => s + (i.line_total ?? 0), 0)
      // HYBRID: line items when present, else legacy header total
      const orderRevenue = items.length > 0 ? itemsTotal : (order.total_price ?? 0)

      // Terms-aware revenue attribution
      const isTerms = order.payment_terms === true
      const isRealized = isTerms ? !!order.terms_paid_at : (order.status === 'delivered' && !!order.delivered_at)
      const revenueDate = isTerms ? (order.terms_paid_at ?? null) : (order.delivered_at ?? null)
      const pipelineDate = isTerms ? (order.terms_payment_date ?? null) : (order.requested_delivery_date ?? null)

      orderInputs.push({
        id: order.id,
        order_number: String(order.order_number),
        customer_name: customerName,
        total_price: orderRevenue,            // item-accurate, legacy-safe
        status: order.status,
        // Adapter: feed the cash-flow engine generically via existing fields
        delivered_at: revenueDate,
        requested_delivery_date: pipelineDate,
        payment_terms: isTerms,
        is_terms_paid: !!order.terms_paid_at,
      })

      if (isRealized && revenueDate) {
        const d = revenueDate.substring(0, 10)
        if (d >= month && d < nextMonth) realizedRevenue += orderRevenue
      } else if (!isRealized) {
        if (isTerms) {
          pipelineTerms += orderRevenue
        } else {
          pipelineNonTerms += orderRevenue
        }
      }
    }

    // Build cash-flow projection if we have a snapshot
    let cashFlow: MonthSummary['cashFlow'] = null
    if (latestSnapshot) {
      const billInputs: BillInput[] = (bills || []).map((b) => ({
        id: b.id,
        name: b.name,
        amount: b.amount,
        amount_paid: b.amount_paid,
        due_date: b.due_date,
        status: b.status as BillInput['status'],
        paid_date: b.paid_date ?? null,
        payment_method: b.payment_method ?? null,
        bank_confirmed: confirmedBillIds.has(b.id),
        vendor: b.vendor?.name ?? null,
      }))

      const snapshotInput: SnapshotInput = {
        id: latestSnapshot.id,
        snapshot_date: latestSnapshot.snapshot_date,
        cash_on_hand: latestSnapshot.cash_on_hand,
      }

      cashFlow = buildCashFlowBoth(snapshotInput, billInputs, orderInputs, today)
    }

    return {
      success: true,
      data: {
        bills: (bills || []) as Bill[],
        latestSnapshot: latestSnapshot as CashSnapshot | null,
        realizedRevenue,
        pipelineRevenue: pipelineNonTerms + pipelineTerms,
        pipelineNonTerms,
        pipelineTerms,
        cashFlow,
        bankBalance,
      },
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// WEEKLY BUDGET SUMMARY
// ============================================================

/**
 * Returns all data needed to render the Weekly Budget view:
 * a rolling N-week waterfall (default 6, max 12) anchored to today.
 *
 * Bills fetched: all non-void unpaid/partial bills (no period_month filter —
 * weekly view crosses month boundaries), plus paid-but-uncleared checks.
 * Orders fetched: bounded to [week1Start, week6End] range.
 */
export async function getWeeklyBudget(params?: { weeks?: number }): Promise<{
  success: boolean
  data?: WeeklySummary
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  const numWeeks = Math.min(params?.weeks ?? 6, 12)

  try {
    const supabase = await createServiceClient()
    const today = new Date().toISOString().substring(0, 10)

    // Compute week boundaries to determine order fetch range
    const boundaries = computeWeekBoundaries(today, numWeeks)
    const week1Start = boundaries[0].weekStart
    const week6End   = boundaries[boundaries.length - 1].weekEnd

    // Determine snapshotDate for revenue filtering (events before snapshot already in CoH)
    // Fetch snapshot first to get the anchor date
    const { data: snapRows, error: snapError } = await supabase
      .from('finance_cash_snapshots')
      .select('*')
      .lte('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)

    if (snapError) {
      console.error('getWeeklyBudget: error fetching snapshot:', snapError)
      return { success: false, error: snapError.message }
    }

    const latestSnapshot = (snapRows?.[0] ?? null) as CashSnapshot | null
    const snapshotDate = latestSnapshot?.snapshot_date ?? today

    // Determine next month beyond week6End for order query (use week6End directly with lte)
    const nextMonthAfterRange = (() => {
      // We don't need incrementMonth here — we bound by week6End directly
      return week6End
    })()

    // Fetch bills: unpaid + partial + paid-uncleared-checks — no period_month filter
    // We include paid bills where paid_date > snapshotDate (future outflows not yet in bank)
    // The engine itself handles uncleared-check logic via bank_confirmed field.
    const [billsRes, ordersRes, bankBalanceRes] = await Promise.all([
      supabase
        .from('finance_bills')
        .select(`
          *,
          payment_method,
          vendor:finance_vendors(id, name)
        `)
        .or('status.eq.unpaid,status.eq.partial,and(status.eq.paid,paid_date.gt.' + snapshotDate + ')')
        .neq('status', 'void'),

      supabase
        .from('orders')
        .select(`
          id, order_number, status, total_price, delivered_at, requested_delivery_date,
          payment_terms, terms_payment_date, terms_paid_at,
          customers(business_name),
          order_items(line_total)
        `)
        .or(
          `and(status.eq.delivered,payment_terms.eq.false,delivered_at.gte.${week1Start},delivered_at.lte.${nextMonthAfterRange}),` +
          `and(status.eq.delivered,payment_terms.eq.true,terms_paid_at.gte.${week1Start},terms_paid_at.lte.${nextMonthAfterRange}),` +
          `and(status.in.(confirmed,packed),payment_terms.eq.false,requested_delivery_date.gte.${week1Start},requested_delivery_date.lte.${nextMonthAfterRange}),` +
          `and(status.in.(confirmed,packed,delivered),payment_terms.eq.true,terms_paid_at.is.null,terms_payment_date.gte.${week1Start},terms_payment_date.lte.${nextMonthAfterRange})`
        )
        .order('requested_delivery_date', { ascending: true })
        .range(0, 4999),

      createServiceClient()
        .then((svc) => svc.rpc('get_bank_balance'))
        .catch((err) => {
          // Non-fatal — a bank RPC failure shouldn't block the whole page, but
          // the failure must still be visible for debugging rather than
          // silently masqueraded as "no bank balance configured".
          console.error('Error fetching bank balance:', err)
          return { data: null, error: err instanceof Error ? err : new Error(String(err)) }
        }),
    ])

    if (billsRes.error) {
      console.error('getWeeklyBudget: error fetching bills:', billsRes.error)
      return { success: false, error: billsRes.error.message }
    }
    if (ordersRes.error) {
      console.error('getWeeklyBudget: error fetching orders:', ordersRes.error)
      return { success: false, error: ordersRes.error.message }
    }

    // FIX 3 (SPRO-82 adversarial review): same payment-ledger-derived
    // bank_confirmed as getMonthSummary() above — see
    // deriveBankConfirmedBillIds()'s doc comment for the full rationale.
    let confirmedBillIds = new Set<string>()
    try {
      const { data: checkPayments } = await supabase
        .from('finance_bill_payments')
        .select('bill_id, bank_bs_id')
        .eq('payment_method', 'check')
      if (checkPayments) {
        confirmedBillIds = deriveBankConfirmedBillIds(checkPayments)
      }
    } catch {
      // non-fatal
    }

    // Resolve bank balance
    let bankBalance: BankBalanceSummary | null = null
    if (bankBalanceRes.data && !bankBalanceRes.error) {
      const row = Array.isArray(bankBalanceRes.data)
        ? bankBalanceRes.data[0]
        : bankBalanceRes.data
      if (row) {
        bankBalance = {
          current:        Number(row.current_balance),
          available:      Number(row.available_balance),
          pending:        Number(row.pending_balance),
          as_of_date:     String(row.as_of_date),
          account_number: String(row.account_number),
        }
      }
    }

    // Map bills to WeeklyBillInput[]
    const billInputs: WeeklyBillInput[] = (billsRes.data ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      amount: b.amount,
      amount_paid: b.amount_paid,
      due_date: b.due_date,
      status: b.status as BillInput['status'],
      paid_date: b.paid_date ?? null,
      payment_method: b.payment_method ?? null,
      bank_confirmed: confirmedBillIds.has(b.id),
      vendor: (b.vendor as { name: string } | null)?.name ?? null,
      planned_pay_date: (b as { planned_pay_date?: string | null }).planned_pay_date ?? null,
    }))

    // Map orders to OrderInput[] — HYBRID revenue rule (same as getMonthSummary)
    const orderInputs: OrderInput[] = []
    for (const order of ordersRes.data ?? []) {
      const customer = Array.isArray(order.customers)
        ? order.customers[0]
        : order.customers
      const customerName = (customer as { business_name?: string } | null)?.business_name ?? 'Unknown'

      const items = (order.order_items ?? []) as { line_total: number | null }[]
      const itemsTotal = items.reduce((s, i) => s + (i.line_total ?? 0), 0)
      const orderRevenue = items.length > 0 ? itemsTotal : (order.total_price ?? 0)

      const isTerms    = order.payment_terms === true
      const revenueDate  = isTerms ? (order.terms_paid_at ?? null) : (order.delivered_at ?? null)
      const pipelineDate = isTerms ? (order.terms_payment_date ?? null) : (order.requested_delivery_date ?? null)

      orderInputs.push({
        id: order.id,
        order_number: String(order.order_number),
        customer_name: customerName,
        total_price: orderRevenue,
        status: order.status,
        delivered_at: revenueDate,
        requested_delivery_date: pipelineDate,
        payment_terms: isTerms,
        is_terms_paid: !!order.terms_paid_at,
      })
    }

    // Run the weekly budget engine
    const snapshotInput = latestSnapshot
      ? { id: latestSnapshot.id, snapshot_date: latestSnapshot.snapshot_date, cash_on_hand: latestSnapshot.cash_on_hand }
      : null

    const result: WeeklyBudgetResult = buildWeeklyBudget(
      snapshotInput,
      billInputs,
      orderInputs,
      today,
      numWeeks
    )

    return {
      success: true,
      data: {
        weeks: result.weeks,
        unbucketedBills: result.unbucketedBills,
        latestSnapshot,
        bankBalance,
        openingBalance: result.openingBalance,
        snapshotDate: result.snapshotDate,
        conservativeTrough: result.conservativeTrough,
        optimisticTrough: result.optimisticTrough,
      },
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// READ ACTIONS — page data fetches
// ============================================================

/**
 * Fetch bills for a given period month with template and vendor joins.
 * Used by the Bills page to replace its direct browser-client query.
 */
export async function getBillsForMonth(month: string): Promise<{
  success: boolean
  data?: Bill[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from('finance_bills')
      .select(`
        *,
        template:finance_bill_templates(id, name, amount),
        vendor:finance_vendors(id, name)
      `)
      .eq('period_month', month)
      .order('due_date', { ascending: true })

    if (error) {
      console.error('Error fetching bills:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: (data || []) as Bill[] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Fetch all bill templates with vendor joins.
 * Used by the Templates page and Bills page to replace direct browser-client queries.
 */
export async function getTemplatesWithVendors(activeOnly = false): Promise<{
  success: boolean
  data?: BillTemplate[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    let query = supabase
      .from('finance_bill_templates')
      .select('*, vendor:finance_vendors(id, name)')
      .order('name', { ascending: true })

    if (activeOnly) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching bill templates:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: (data || []) as BillTemplate[] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * Fetch vendors.
 * Used by the Vendors page and bill/template forms to replace direct browser-client queries.
 */
export async function getVendors(activeOnly = false): Promise<{
  success: boolean
  data?: Vendor[]
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    let query = supabase
      .from('finance_vendors')
      .select('*')
      .order('name', { ascending: true })

    if (activeOnly) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching vendors:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================================
// BANK SYNC
// ============================================================

/**
 * Manual "Sync now" (copy-only) — runs the same work the daily cron does:
 *   1. sync_bank_snapshot_to_finance()  (writes today's cash snapshot from the bank feed)
 *   2. run_daily_reconciliation()        (auto-applies checks, proposes non-check matches)
 *
 * NOTE: This action only copies data that BankSync has already pushed to the DB.
 * Use syncBankFromSource() for a true end-to-end pull that triggers BankSync first.
 *
 * Does NOT apply the Chicago-hour gate — that gate is cron-only.
 * Restricted to admin / management (same as all other finance mutations).
 *
 * @deprecated Prefer syncBankFromSource() for the UI "Sync now" button.
 */
export async function syncBankNow(): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Step 1 — snapshot
    const { error: snapError } = await supabase.rpc('sync_bank_snapshot_to_finance')
    if (snapError) {
      console.error('syncBankNow: sync_bank_snapshot_to_finance error:', snapError)
      return { success: false, error: snapError.message }
    }

    // Step 2 — reconciliation
    const { error: reconError } = await supabase.rpc('run_daily_reconciliation')
    if (reconError) {
      console.error('syncBankNow: run_daily_reconciliation error:', reconError)
      return { success: false, error: reconError.message }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

/**
 * True end-to-end bank pull — triggers BankSync feeds, polls to completion,
 * then copies to finance and runs reconciliation.
 *
 * This replaces the old syncBankNow() as the primary "Sync now" action for the UI.
 * It handles the case where BankSync's scheduled push failed (transient error, no retry)
 * by proactively triggering the pull from the API.
 *
 * Steps:
 *   1. Gate to admin / management.
 *   2. Retrieve API key from Supabase Vault via get_banksync_api_key().
 *   3. POST /v1/feeds/{balances}/sync and /v1/feeds/{transactions}/sync.
 *   4. Poll each job until completed/failed or ~60s timeout.
 *   5. Call sync_bank_snapshot_to_finance() then run_daily_reconciliation().
 *   6. Return structured result.
 */
export async function syncBankFromSource(): Promise<PullResult> {
  const auth = await requireFinance()
  if (!auth.authorized) {
    return {
      success: false,
      balancesStatus: null,
      transactionsStatus: null,
      freshDate: null,
      cashOnHand: null,
      errors: [auth.reason],
    }
  }

  try {
    const supabase = await createServiceClient()

    // Retrieve the BankSync API key from Vault via the SECURITY DEFINER accessor.
    // PostgREST does not expose the vault schema directly; this RPC is the bridge.
    const { data: apiKey, error: keyError } = await supabase.rpc('get_banksync_api_key')
    if (keyError || !apiKey) {
      return {
        success: false,
        balancesStatus: null,
        transactionsStatus: null,
        freshDate: null,
        cashOnHand: null,
        errors: [keyError?.message ?? 'BankSync API key not found in Vault (banksync_api_key)'],
      }
    }

    return await pullBankSync(apiKey as string)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('syncBankFromSource error:', msg)
    return {
      success: false,
      balancesStatus: null,
      transactionsStatus: null,
      freshDate: null,
      cashOnHand: null,
      errors: [msg],
    }
  }
}

// ============================================================
// BILL REVIEW DETAIL (for reconciliation side panel)
// ============================================================

export interface BillReviewDetail {
  bill: Bill & {
    vendor_name: string | null
    template_name: string | null
    from_quickbooks: boolean
  }
  /** Other bills with the same amount (excluding this bill) */
  siblings: Array<{
    id: string
    name: string
    vendor_name: string | null
    status: BillStatus
    due_date: string
    amount: number
  }>
}

/**
 * Fetches full bill detail plus sibling bills at the same amount.
 * Used by the reconciliation review Sheet panel.
 * Gated to admin / management (same as all finance actions).
 */
export async function getBillReviewDetail(billId: string): Promise<{
  success: boolean
  data?: BillReviewDetail
  error?: string
}> {
  const auth = await requireFinance()
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const supabase = await createServiceClient()

    // Fetch the bill with joined vendor + template
    const { data: raw, error: billError } = await supabase
      .from('finance_bills')
      .select(`
        *,
        vendor:finance_vendors(id, name),
        template:finance_bill_templates(id, name, amount)
      `)
      .eq('id', billId)
      .single()

    if (billError || !raw) {
      return { success: false, error: billError?.message ?? 'Bill not found' }
    }

    const vendorData = raw.vendor as { id: string; name: string } | { id: string; name: string }[] | null
    const vendorName = Array.isArray(vendorData) ? (vendorData[0]?.name ?? null) : (vendorData?.name ?? null)

    const templateData = raw.template as { id: string; name: string; amount: number | null } | null
    const templateName = Array.isArray(templateData) ? (templateData[0]?.name ?? null) : (templateData?.name ?? null)

    const bill: BillReviewDetail['bill'] = {
      id: raw.id,
      template_id: raw.template_id,
      vendor_id: raw.vendor_id,
      name: raw.name,
      period_month: raw.period_month,
      amount: Number(raw.amount),
      due_date: raw.due_date,
      status: raw.status as BillStatus,
      amount_paid: Number(raw.amount_paid),
      paid_date: raw.paid_date,
      payment_method: raw.payment_method,
      payment_ref: raw.payment_ref,
      notes: raw.notes,
      created_by: raw.created_by,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      vendor_name: vendorName,
      template_name: templateName,
      from_quickbooks: typeof raw.notes === 'string' && raw.notes.toLowerCase().includes('quickbooks'),
    }

    // Find sibling bills at the same amount (excluding this one)
    const { data: siblingRaw, error: siblingError } = await supabase
      .from('finance_bills')
      .select(`
        id,
        name,
        status,
        due_date,
        amount,
        vendor:finance_vendors(id, name)
      `)
      .eq('amount', raw.amount)
      .neq('id', billId)
      .neq('status', 'void')
      .order('due_date', { ascending: false })
      .limit(10)

    if (siblingError) {
      // Non-fatal: return bill without siblings
      console.error('getBillReviewDetail siblings error:', siblingError)
    }

    const siblings: BillReviewDetail['siblings'] = (siblingRaw ?? []).map((s) => {
      const sv = s.vendor as { id: string; name: string } | { id: string; name: string }[] | null
      const svName = Array.isArray(sv) ? (sv[0]?.name ?? null) : (sv?.name ?? null)
      return {
        id: s.id,
        name: s.name,
        vendor_name: svName,
        status: s.status as BillStatus,
        due_date: s.due_date,
        amount: Number(s.amount),
      }
    })

    return { success: true, data: { bill, siblings } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg }
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Returns the first day of the next month given 'YYYY-MM-01'.
 */
function incrementMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  const nextDate = new Date(year, mon, 1) // month is 0-indexed in Date constructor, so mon = this month's 1-indexed value works directly
  return `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-01`
}
