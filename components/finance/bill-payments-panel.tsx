'use client'

// SPRO-82 (Phase C1): the bill-payment ledger UI. A bill can now hold several
// payments (finance_bill_payments) — this is the "list payments / add a
// payment / edit or delete a payment" panel embedded in the Edit Bill sheet
// (app/dashboard/finance/bills/page.tsx). Extracted into its own file per the
// spec's "if a payments list/form is big enough to warrant extraction, put it
// in components/finance/" instruction — bills/page.tsx is already 1700+ lines.
//
// PaymentFormFields / PaymentFormState / PaymentFormErrors / PAYMENT_METHODS
// are also exported so bills/page.tsx can reuse the exact same field markup
// for the "already paid" single-payment affordance on a brand-new bill,
// without duplicating the JSX for amount/date/method/check-number/notes.

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { CheckCircle2, Clock, Edit2, Trash2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getBillPayments,
  recordBillPayment,
  updateBillPayment,
  deleteBillPayment,
} from '@/actions/finance'
import type { Bill, BillPayment } from '@/actions/finance'
// PaymentMethod comes from the lib, not '@/actions/finance' — see the note at
// the top of actions/finance.ts: a 'use server' file cannot re-export a type.
import type { PaymentMethod } from '@/lib/finance/bill-payments'

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function todayStr(): string {
  return new Date().toISOString().substring(0, 10)
}

// ---------------------------------------------------------------------
// Shared payment-field form — amount / date / method / check# / notes.
// Used by both the "Add payment" / "Edit payment" rows below AND, via the
// exports, by bills/page.tsx's new-bill "Already paid" affordance.
// ---------------------------------------------------------------------

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Debit Card' },
  { value: 'ach', label: 'ACH' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
]

export interface PaymentFormState {
  amount: string
  paid_date: string
  payment_method: string
  payment_ref: string
  notes: string
}

export interface PaymentFormErrors {
  amount?: string
  payment_method?: string
  payment_ref?: string
  paid_date?: string
}

export function emptyPaymentForm(defaultAmount = ''): PaymentFormState {
  return {
    amount: defaultAmount,
    paid_date: todayStr(),
    payment_method: '',
    payment_ref: '',
    notes: '',
  }
}

/**
 * Client-side pre-check mirroring validatePaymentInput()'s field rules
 * (lib/finance/bill-payments.ts) — method required, check needs a ref,
 * amount > 0. The overpay/void checks are NOT duplicated here: those need
 * the bill's current amount_paid, which the server already has, and the
 * server's 'would_overpay' message is what gets shown (spec: "render the
 * server's message inline").
 */
export function validatePaymentFormLocal(form: PaymentFormState): PaymentFormErrors {
  const errors: PaymentFormErrors = {}
  const amt = parseFloat(form.amount)
  if (!Number.isFinite(amt) || amt <= 0) {
    errors.amount = 'Amount must be greater than 0'
  }
  if (!form.payment_method) {
    errors.payment_method = 'Payment method is required'
  }
  if (form.payment_method === 'check' && !form.payment_ref.trim()) {
    errors.payment_ref = 'Check number is required when paying by check'
  }
  if (!form.paid_date) {
    errors.paid_date = 'Payment date is required'
  }
  return errors
}

export function PaymentFormFields({
  idPrefix,
  form,
  setForm,
  errors,
  setErrors,
  disabled,
  hideNotes,
}: {
  idPrefix: string
  form: PaymentFormState
  setForm: Dispatch<SetStateAction<PaymentFormState>>
  errors: PaymentFormErrors
  setErrors: Dispatch<SetStateAction<PaymentFormErrors>>
  disabled?: boolean
  /**
   * createBill()'s "already paid" insert path (actions/finance.ts) does not
   * pass a `notes` field through to the recordBillPayment() call it makes —
   * only editing an EXISTING bill's payments (updateBillPayment/
   * recordBillPayment via BillPaymentsPanel) supports payment notes. Hide the
   * field on the new-bill "Already paid" affordance so it can't collect text
   * that would silently be discarded.
   */
  hideNotes?: boolean
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-amount`} className="text-xs">Amount</Label>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
            <Input
              id={`${idPrefix}-amount`}
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={form.amount}
              disabled={disabled}
              onChange={(e) => {
                setForm((p) => ({ ...p, amount: e.target.value }))
                if (errors.amount) setErrors((p) => ({ ...p, amount: undefined }))
              }}
              className={cn('pl-6 h-9 text-sm', errors.amount && 'border-red-500')}
            />
          </div>
          {errors.amount && <p className="text-red-500 text-[11px]">{errors.amount}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-date`} className="text-xs">Date</Label>
          <Input
            id={`${idPrefix}-date`}
            type="date"
            value={form.paid_date}
            disabled={disabled}
            onChange={(e) => {
              setForm((p) => ({ ...p, paid_date: e.target.value }))
              if (errors.paid_date) setErrors((p) => ({ ...p, paid_date: undefined }))
            }}
            className={cn('h-9 text-sm', errors.paid_date && 'border-red-500')}
          />
          {errors.paid_date && <p className="text-red-500 text-[11px]">{errors.paid_date}</p>}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-method`} className="text-xs">Method</Label>
        <Select
          value={form.payment_method}
          onValueChange={(v) => {
            setForm((p) => ({ ...p, payment_method: v }))
            if (errors.payment_method) setErrors((p) => ({ ...p, payment_method: undefined }))
            if (v !== 'check' && errors.payment_ref) setErrors((p) => ({ ...p, payment_ref: undefined }))
          }}
          disabled={disabled}
        >
          <SelectTrigger
            id={`${idPrefix}-method`}
            className={cn('h-9 text-sm', errors.payment_method && 'border-red-500')}
          >
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.payment_method && <p className="text-red-500 text-[11px]">{errors.payment_method}</p>}
      </div>

      {form.payment_method === 'check' && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-ref`} className="text-xs">Check Number</Label>
          <Input
            id={`${idPrefix}-ref`}
            placeholder="e.g. 1234"
            value={form.payment_ref}
            disabled={disabled}
            onChange={(e) => {
              setForm((p) => ({ ...p, payment_ref: e.target.value }))
              if (errors.payment_ref) setErrors((p) => ({ ...p, payment_ref: undefined }))
            }}
            className={cn('h-9 text-sm', errors.payment_ref && 'border-red-500')}
          />
          {errors.payment_ref && <p className="text-red-500 text-[11px]">{errors.payment_ref}</p>}
        </div>
      )}

      {!hideNotes && (
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-notes`} className="text-xs">Notes (optional)</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          placeholder="Any details about this payment..."
          value={form.notes}
          disabled={disabled}
          onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          rows={2}
          className="text-sm"
        />
      </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------
// BillPaymentsPanel — the list + add/edit/delete UI for an EXISTING bill.
// ---------------------------------------------------------------------

interface BillPaymentsPanelProps {
  bill: Bill
  /**
   * Called after any successful add/edit/delete so the parent can refresh
   * its own copy of the bill (amount_paid/status/paid_date are derived by
   * the DB trigger from these payments, so the parent's `bill` prop is only
   * as fresh as the last time it re-fetched).
   */
  onPaymentsChanged: () => void | Promise<void>
  disabled?: boolean
}

export function BillPaymentsPanel({ bill, onPaymentsChanged, disabled }: BillPaymentsPanelProps) {
  const [payments, setPayments] = useState<BillPayment[]>([])
  const [loading, setLoading] = useState(true)

  // Add-payment form
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState<PaymentFormState>(() => emptyPaymentForm())
  const [addErrors, setAddErrors] = useState<PaymentFormErrors>({})
  const [addServerError, setAddServerError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  // Inline edit-payment state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<PaymentFormState>(() => emptyPaymentForm())
  const [editErrors, setEditErrors] = useState<PaymentFormErrors>({})
  const [editServerError, setEditServerError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<BillPayment | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchPayments = async () => {
    setLoading(true)
    try {
      const res = await getBillPayments(bill.id)
      if (res.success) {
        setPayments(res.data ?? [])
      } else {
        toast.error(res.error ?? 'Failed to load payments')
      }
    } catch (err) {
      console.error('Error fetching bill payments:', err)
      toast.error('Failed to load payments')
    } finally {
      setLoading(false)
    }
  }

  // Re-fetch whenever the sheet is pointed at a different bill. Also close
  // any open add/edit affordance — it belongs to the PREVIOUS bill's data.
  useEffect(() => {
    fetchPayments()
    setAddOpen(false)
    setEditingId(null)
    setDeleteTarget(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill.id])

  const remaining = Math.max(bill.amount - bill.amount_paid, 0)
  const isVoid = bill.status === 'void'
  const isDisabled = Boolean(disabled)

  const openAddForm = () => {
    setAddForm(emptyPaymentForm(remaining > 0 ? remaining.toFixed(2) : ''))
    setAddErrors({})
    setAddServerError(null)
    setAddOpen(true)
  }

  const handleAddPayment = async () => {
    const errors = validatePaymentFormLocal(addForm)
    if (Object.keys(errors).length > 0) {
      setAddErrors(errors)
      return
    }
    setAddErrors({})
    setAddServerError(null)
    setAddSaving(true)
    try {
      const result = await recordBillPayment({
        bill_id: bill.id,
        amount: parseFloat(addForm.amount),
        paid_date: addForm.paid_date,
        payment_method: addForm.payment_method as PaymentMethod,
        payment_ref: addForm.payment_ref.trim() || null,
        notes: addForm.notes.trim() || null,
      })
      if (!result.success) {
        // would_overpay (and any other server-side rejection): render the
        // server's own wording inline and keep the form exactly as entered —
        // never silently clamp or round (spec constraint).
        setAddServerError(result.error ?? 'Failed to record payment')
        return
      }
      toast.success('Payment recorded')
      setAddOpen(false)
      await fetchPayments()
      await onPaymentsChanged()
    } catch (err) {
      console.error('Error recording payment:', err)
      toast.error('Failed to record payment')
    } finally {
      setAddSaving(false)
    }
  }

  const openEditForm = (payment: BillPayment) => {
    setAddOpen(false)
    setEditingId(payment.id)
    setEditForm({
      amount: String(payment.amount),
      paid_date: payment.paid_date,
      payment_method: payment.payment_method,
      payment_ref: payment.payment_ref ?? '',
      notes: payment.notes ?? '',
    })
    setEditErrors({})
    setEditServerError(null)
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    const errors = validatePaymentFormLocal(editForm)
    if (Object.keys(errors).length > 0) {
      setEditErrors(errors)
      return
    }
    setEditErrors({})
    setEditServerError(null)
    setEditSaving(true)
    try {
      const result = await updateBillPayment(editingId, {
        amount: parseFloat(editForm.amount),
        paid_date: editForm.paid_date,
        payment_method: editForm.payment_method as PaymentMethod,
        payment_ref: editForm.payment_ref.trim() || null,
        notes: editForm.notes.trim() || null,
      })
      if (!result.success) {
        setEditServerError(result.error ?? 'Failed to update payment')
        return
      }
      toast.success('Payment updated')
      setEditingId(null)
      await fetchPayments()
      await onPaymentsChanged()
    } catch (err) {
      console.error('Error updating payment:', err)
      toast.error('Failed to update payment')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDeletePayment = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const result = await deleteBillPayment(deleteTarget.id)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to delete payment')
        return
      }
      toast.success('Payment deleted')
      setDeleteTarget(null)
      await fetchPayments()
      await onPaymentsChanged()
    } catch (err) {
      console.error('Error deleting payment:', err)
      toast.error('Failed to delete payment')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Payments</h3>
        <span className={cn('text-sm font-medium whitespace-nowrap', remaining > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400')}>
          Remaining: {formatMoney(remaining)}
        </span>
      </div>

      {isVoid && (
        <p className="text-xs text-muted-foreground">
          This bill is voided. Un-void it to record, edit, or delete payments.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground py-2">Loading payments...</p>
      ) : payments.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No payments recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {payments.map((p) => (
            <li key={p.id} className="rounded border p-2">
              {editingId === p.id ? (
                <div className="space-y-2">
                  <PaymentFormFields
                    idPrefix={`edit-payment-${p.id}`}
                    form={editForm}
                    setForm={setEditForm}
                    errors={editErrors}
                    setErrors={setEditErrors}
                    disabled={editSaving}
                  />
                  {editServerError && (
                    <p className="text-xs text-destructive">{editServerError}</p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1 h-8 text-xs" disabled={editSaving} onClick={handleSaveEdit}>
                      {editSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      disabled={editSaving}
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap text-sm">
                      <span className="font-medium">{formatMoney(p.amount)}</span>
                      <span className="text-muted-foreground">
                        {format(parseISO(p.paid_date), 'MMM d, yyyy')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
                      <span className="capitalize">{p.payment_method}</span>
                      {p.payment_ref && <span>#{p.payment_ref}</span>}
                      {p.bank_bs_id !== null ? (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-green-700 border-green-300 dark:text-green-400">
                          <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                          Reconciled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
                          <Clock className="h-2.5 w-2.5 mr-0.5" />
                          Awaiting bank match
                        </Badge>
                      )}
                    </div>
                    {p.notes && <p className="text-xs text-muted-foreground">{p.notes}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={isDisabled || isVoid}
                      onClick={() => openEditForm(p)}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      disabled={isDisabled || isVoid}
                      onClick={() => setDeleteTarget(p)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add payment */}
      {!addOpen ? (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isDisabled || isVoid || remaining <= 0}
          onClick={openAddForm}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          {remaining <= 0 ? 'Bill fully paid' : 'Add Payment'}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border p-3 bg-muted/30">
          <PaymentFormFields
            idPrefix="add-payment"
            form={addForm}
            setForm={setAddForm}
            errors={addErrors}
            setErrors={setAddErrors}
            disabled={addSaving}
          />
          {addServerError && (
            <p className="text-xs text-destructive">{addServerError}</p>
          )}
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 h-8 text-xs" disabled={addSaving} onClick={handleAddPayment}>
              {addSaving ? 'Saving...' : 'Save Payment'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={addSaving}
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  This will permanently delete the {formatMoney(deleteTarget.amount)} payment recorded on{' '}
                  {format(parseISO(deleteTarget.paid_date), 'MMM d, yyyy')}. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeletePayment}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
