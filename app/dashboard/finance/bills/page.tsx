'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { toast } from 'sonner'
import {
  Plus,
  Banknote,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  List,
  CheckCircle,
  AlertTriangle,
  Minus,
  MoreVertical,
  FileStack,
  Edit2,
  Trash2,
  Check,
  ChevronsUpDown,
  Search,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import {
  createBill,
  updateBill,
  deleteBill,
  setBillVoid,
  instantiateBillsFromTemplates,
  getBillsForMonth,
  getTemplatesWithVendors,
  getVendors,
} from '@/actions/finance'
import type { Bill, BillStatus, BillTemplate, Vendor } from '@/actions/finance'
import {
  createBillFromBankTransaction,
  getDuplicateBillCandidates,
  linkBillToBankTransaction,
} from '@/app/dashboard/finance/_actions/bank'
import { derivePrefillPayment } from '@/app/dashboard/finance/_lib/bank-prefill'
import type { DuplicateBillCandidate } from '@/app/dashboard/finance/_lib/bank-prefill'
import { Checkbox } from '@/components/ui/checkbox'
import { VendorCombobox } from '@/components/finance/vendor-combobox'
import {
  BillPaymentsPanel,
  PaymentFormFields,
  emptyPaymentForm,
  validatePaymentFormLocal,
} from '@/components/finance/bill-payments-panel'
import type { PaymentFormState, PaymentFormErrors } from '@/components/finance/bill-payments-panel'

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function currentMonthStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

function prevMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function nextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function getMonthLabel(month: string): string {
  return format(parseISO(month), 'MMMM yyyy')
}

// -----------------------------------------------------------------------
// Status badge
// -----------------------------------------------------------------------

function BillStatusBadge({ status }: { status: BillStatus }) {
  switch (status) {
    case 'paid':
      return (
        <Badge variant="default" className="bg-green-600">
          <CheckCircle className="h-3 w-3 mr-1" />
          Paid
        </Badge>
      )
    case 'partial':
      return (
        <Badge variant="default" className="bg-amber-500">
          <Minus className="h-3 w-3 mr-1" />
          Partial
        </Badge>
      )
    case 'unpaid':
      return (
        <Badge variant="destructive">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Unpaid
        </Badge>
      )
    case 'void':
      return <Badge variant="outline" className="text-muted-foreground">Void</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

// -----------------------------------------------------------------------
// Types for local form state
// -----------------------------------------------------------------------

// SPRO-82: status/amount_paid/paid_date/payment_method/payment_ref are now
// derived-by-trigger columns on finance_bills (see updateBill()'s own
// comment in actions/finance.ts) — this form only ever edits the bill's own
// fields. Payments are edited through BillPaymentsPanel (existing bills) or
// the "Already paid" affordance below (new bills only).
interface BillFormData {
  name: string
  vendor_id: string
  amount: string
  due_date: string
  notes: string
}

interface BillFormErrors {
  name?: string
  amount?: string
  due_date?: string
}

type ViewMode = 'table' | 'card'

// -----------------------------------------------------------------------
// Main page
// -----------------------------------------------------------------------

// useSearchParams() requires a Suspense boundary in the App Router, so the
// page body lives in BillsPageContent and the default export only wraps it.
export default function BillsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-muted-foreground">Loading bills...</div>
        </div>
      }
    >
      <BillsPageContent />
    </Suspense>
  )
}

function BillsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading: authLoading } = useAuth()

  const [month, setMonth] = useState(currentMonthStr())
  const [bills, setBills] = useState<Bill[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [templates, setTemplates] = useState<BillTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [vendorFilter, setVendorFilter] = useState<string>('all')
  const [vendorFilterOpen, setVendorFilterOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('table')

  // Bill form sheet
  const [billSheetOpen, setBillSheetOpen] = useState(false)
  const [editingBill, setEditingBill] = useState<Bill | null>(null)
  const [billForm, setBillForm] = useState<BillFormData>({
    name: '',
    vendor_id: '',
    amount: '',
    due_date: '',
    notes: '',
  })
  const [billSaving, setBillSaving] = useState(false)
  const [billFormErrors, setBillFormErrors] = useState<BillFormErrors>({})
  const [voidToggling, setVoidToggling] = useState(false)

  // SPRO-82 (C1): new-bill-only "Already paid" affordance. Editing bills no
  // longer edits payments inline (that's BillPaymentsPanel below) — but
  // creating a brand-new bill still needs a simple one-payment shortcut so a
  // bill that was already paid before it was entered (including the SPRO-77
  // bank-prefill flow) doesn't need a separate "add payment" round trip right
  // after creation.
  const [newBillPaid, setNewBillPaid] = useState(false)
  const [newBillPayment, setNewBillPayment] = useState<PaymentFormState>(() => emptyPaymentForm())
  const [newBillPaymentErrors, setNewBillPaymentErrors] = useState<PaymentFormErrors>({})

  // SPRO-77: set when the create sheet was opened from an untracked bank
  // expense (Finance overview → "Create Bill"). While set, saving a NEW bill
  // goes through createBillFromBankTransaction() so the bill is also
  // reconciled against that bank transaction. Cleared as soon as an attempt
  // has been made, and by openNewBillSheet(), so a later manual bill can never
  // be wrongly reconciled.
  const [pendingBankBsId, setPendingBankBsId] = useState<number | null>(null)

  // SPRO-77 (live testing): existing non-void bills for the same amount within
  // 45 days of the bank transaction. The reconciliation matcher gates on a
  // vendor keyword appearing in the bank description, so a real bill can exist
  // for a transaction the matcher still reports as untracked (bs_id 1083's
  // $22,815 "PSO - large" bill, defeated by the bank's "POS BILL" typo) — and
  // creating a bill from it would double the liability. Advisory here; the
  // server refuses outright unless allowDuplicate is set.
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateBillCandidate[]>([])
  const [duplicateChecking, setDuplicateChecking] = useState(false)
  // Explicit "yes, I really want a second bill" — gates the Save button.
  const [duplicateAck, setDuplicateAck] = useState(false)
  const [linkingBillId, setLinkingBillId] = useState<string | null>(null)

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingBill, setDeletingBill] = useState<Bill | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)

  // Instantiate dialog
  const [instantiateDialogOpen, setInstantiateDialogOpen] = useState(false)
  const [instantiating, setInstantiating] = useState(false)
  const [instantiatePreview, setInstantiatePreview] = useState<{
    toCreate: BillTemplate[]
    toSkip: BillTemplate[]
  } | null>(null)
  const [instantiatePreviewLoading, setInstantiatePreviewLoading] = useState(false)

  // Budget vs actual
  const [budgetOpen, setBudgetOpen] = useState(false)

  const userRole = user?.role || 'standard'
  const canManage = userRole === 'admin' || userRole === 'management'

  useEffect(() => {
    if (!authLoading && user && !canManage) {
      router.push('/dashboard')
    }
  }, [user, authLoading, canManage, router])

  useEffect(() => {
    if (canManage) {
      fetchData()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, month])

  // SPRO-77: open the create sheet prefilled from an untracked bank expense.
  // Read the params exactly ONCE — the ref guard means no later re-render (or
  // the router.replace() below, which itself changes searchParams) can reopen
  // the sheet after the user has closed it.
  const prefillConsumed = useRef(false)

  // Invalidation token for the in-flight duplicate check. Bumped whenever the
  // sheet stops being about that bank transaction (closed, or reopened for
  // something else), so a slow response can never paint a warning onto — and
  // disable the Save button of — an unrelated bill.
  const duplicateRequestRef = useRef(0)

  useEffect(() => {
    if (prefillConsumed.current) return

    const name = searchParams.get('prefill_name')
    if (!name) return

    prefillConsumed.current = true

    const amount = searchParams.get('prefill_amount') ?? ''
    const dueDate = searchParams.get('prefill_due_date') ?? ''
    const memo = searchParams.get('prefill_memo') ?? ''
    const desc = searchParams.get('prefill_desc') ?? ''
    const bsIdRaw = searchParams.get('prefill_bs_id')
    const bsId = bsIdRaw != null && bsIdRaw !== '' ? Number(bsIdRaw) : NaN

    // Payment method comes from the bank description: a check keeps its parsed
    // check number, and a check with an unparsable number still records as a
    // check with a blank ref so the sheet's own validation asks for it.
    const { payment_method, payment_ref } = derivePrefillPayment(desc || memo)

    setEditingBill(null)
    setBillForm({
      name,
      vendor_id: '',            // vendor is a deliberate manual choice
      amount,
      due_date: dueDate,
      notes: memo,
    })
    setBillFormErrors({})
    // SPRO-82: the money has already left the bank, so prefill a single
    // "already paid" payment instead of a status:'paid' bill field — same
    // full amount, editable down if it turns out to be a partial.
    setNewBillPaid(true)
    setNewBillPayment({
      amount,
      paid_date: dueDate || new Date().toISOString().substring(0, 10),
      payment_method,
      payment_ref,
      notes: '',
    })
    setNewBillPaymentErrors({})
    setPendingBankBsId(Number.isFinite(bsId) ? bsId : null)
    setDuplicateCandidates([])
    setDuplicateAck(false)
    setBillSheetOpen(true)

    // Look for a bill that already covers this money, in the background — the
    // sheet is usable immediately and the warning appears when the answer
    // arrives. A failure here is not surfaced: it only costs the user the
    // heads-up, and createBillFromBankTransaction() runs the same check
    // server-side and refuses on its own.
    if (Number.isFinite(bsId)) {
      const token = ++duplicateRequestRef.current
      setDuplicateChecking(true)
      getDuplicateBillCandidates(bsId)
        .then((res) => {
          if (duplicateRequestRef.current !== token) return
          if (res.success && res.data) setDuplicateCandidates(res.data)
          else if (!res.success) console.error('Duplicate bill check failed:', res.error)
        })
        .catch((err) => console.error('Duplicate bill check failed:', err))
        .finally(() => {
          if (duplicateRequestRef.current === token) setDuplicateChecking(false)
        })
    }

    // Show the month the new bill will land in (period_month is derived from
    // due_date server-side), otherwise it can be created into a month the user
    // isn't looking at and appear to have vanished.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setMonth(`${dueDate.substring(0, 7)}-01`)
    }

    // Drop the params so a refresh (or a back-navigation) doesn't re-fire this.
    router.replace('/dashboard/finance/bills', { scroll: false })
  }, [searchParams, router])

  const fetchData = async () => {
    setLoading(true)
    try {
      const [billsRes, vendorsRes, templatesRes] = await Promise.all([
        getBillsForMonth(month),
        getVendors(true),
        getTemplatesWithVendors(true),
      ])

      if (!billsRes.success || !billsRes.data) throw new Error(billsRes.error ?? 'Failed to load bills')
      if (!vendorsRes.success || !vendorsRes.data) throw new Error(vendorsRes.error ?? 'Failed to load vendors')
      if (!templatesRes.success || !templatesRes.data) throw new Error(templatesRes.error ?? 'Failed to load templates')

      setBills(billsRes.data)
      setVendors(vendorsRes.data)
      setTemplates(templatesRes.data)
    } catch (err) {
      console.error('Error fetching bills data:', err)
      toast.error('Failed to load bills')
    } finally {
      setLoading(false)
    }
  }

  // SPRO-82: re-fetches just the bills list (amount_paid/status/paid_date are
  // derived-by-trigger from finance_bill_payments) after a payment is
  // added/edited/deleted in BillPaymentsPanel, and keeps `editingBill` — a
  // point-in-time snapshot the sheet is still showing — in sync so the
  // read-only status badge and the "Remaining" line update live without the
  // user having to close and reopen the sheet.
  const refreshAfterPaymentChange = async () => {
    const res = await getBillsForMonth(month)
    if (!res.success || !res.data) {
      console.error('Error refreshing bills after payment change:', res.error)
      return
    }
    setBills(res.data)
    setEditingBill((prev) => {
      if (!prev) return prev
      return res.data!.find((b) => b.id === prev.id) ?? prev
    })
  }

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  const filteredBills = bills.filter((b) => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    if (vendorFilter !== 'all' && b.vendor_id !== vendorFilter) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matchesName = b.name.toLowerCase().includes(q)
      const matchesVendor = b.vendor?.name?.toLowerCase().includes(q) ?? false
      if (!matchesName && !matchesVendor) return false
    }
    return true
  })

  const hasActiveFilters = searchQuery !== '' || statusFilter !== 'all' || vendorFilter !== 'all'

  const clearFilters = () => {
    setSearchQuery('')
    setStatusFilter('all')
    setVendorFilter('all')
  }

  // -----------------------------------------------------------------------
  // Bill form (create / edit)
  // -----------------------------------------------------------------------

  // Everything tying the sheet to a bank transaction. Cleared whenever the
  // sheet is opened for something else, and when it closes, so a stale
  // duplicate warning (or a stale bank link) can never apply to the next bill.
  const clearBankPrefillState = () => {
    // Abandon any in-flight duplicate check along with the state it would land in.
    duplicateRequestRef.current += 1
    setPendingBankBsId(null)
    setDuplicateCandidates([])
    setDuplicateAck(false)
    setDuplicateChecking(false)
    // The "Already paid" affordance only ever applies to the NEW-bill flow
    // that was just abandoned — never let it survive into the next sheet.
    setNewBillPaid(false)
    setNewBillPayment(emptyPaymentForm())
    setNewBillPaymentErrors({})
  }

  const handleBillSheetOpenChange = (open: boolean) => {
    setBillSheetOpen(open)
    if (!open) clearBankPrefillState()
  }

  const openNewBillSheet = () => {
    setEditingBill(null)
    // Never carry a bank link over into a manually-started bill.
    clearBankPrefillState()
    setBillForm({
      name: '',
      vendor_id: '',
      amount: '',
      due_date: '',
      notes: '',
    })
    setBillFormErrors({})
    setBillSheetOpen(true)
  }

  const openEditBillSheet = (bill: Bill) => {
    setEditingBill(bill)
    // Defence in depth: the edit path never reads pendingBankBsId, but an
    // abandoned prefill must not survive into any other save.
    clearBankPrefillState()
    setBillForm({
      name: bill.name,
      vendor_id: bill.vendor_id ?? '',
      amount: String(bill.amount),
      due_date: bill.due_date,
      notes: bill.notes ?? '',
    })
    setBillFormErrors({})
    setBillSheetOpen(true)
  }

  const handleToggleVoid = async () => {
    if (!editingBill) return
    const nextVoid = editingBill.status !== 'void'
    setVoidToggling(true)
    try {
      const result = await setBillVoid(editingBill.id, nextVoid)
      if (!result.success || !result.data) {
        toast.error(result.error || 'Failed to update bill status')
        return
      }
      toast.success(nextVoid ? 'Bill voided' : 'Bill un-voided')
      const updated = result.data
      setEditingBill(updated)
      setBills((prev) => prev.map((b) => (b.id === updated.id ? updated : b)))
    } catch (err) {
      console.error('Error toggling bill void state:', err)
      toast.error('Failed to update bill status')
    } finally {
      setVoidToggling(false)
    }
  }

  const handleSaveBill = async () => {
    const amount = parseFloat(billForm.amount)
    // "Already paid" only applies to a brand-new bill — editing goes through
    // BillPaymentsPanel instead (spec C1).
    const recordingNewPayment = !editingBill && newBillPaid

    // Collect all field errors up front so we can show them inline
    const errors: BillFormErrors = {}

    if (!billForm.name.trim()) {
      errors.name = 'Bill name is required'
    }
    if (isNaN(amount) || amount < 0) {
      errors.amount = 'Please enter a valid amount'
    }
    if (!billForm.due_date) {
      errors.due_date = 'Due date is required'
    }

    const paymentErrors: PaymentFormErrors = recordingNewPayment
      ? validatePaymentFormLocal(newBillPayment)
      : {}
    if (recordingNewPayment && !paymentErrors.amount) {
      const paidAmt = parseFloat(newBillPayment.amount)
      if (!isNaN(amount) && paidAmt > amount) {
        paymentErrors.amount = 'Amount paid cannot exceed the bill amount'
      }
    }

    if (Object.keys(errors).length > 0 || Object.keys(paymentErrors).length > 0) {
      setBillFormErrors(errors)
      setNewBillPaymentErrors(paymentErrors)
      toast.error('Please fix the highlighted fields')
      return
    }

    setBillFormErrors({})
    setNewBillPaymentErrors({})

    setBillSaving(true)
    try {
      if (editingBill) {
        const result = await updateBill(editingBill.id, {
          name: billForm.name.trim(),
          vendor_id: billForm.vendor_id || null,
          amount,
          due_date: billForm.due_date,
          notes: billForm.notes.trim() || null,
        })
        if (!result.success) {
          // SPRO-82: reducing the amount below what's already been paid comes
          // back as errorCode 'would_overpay' — surface the server's own
          // wording on the amount field (spec: "surface that inline on the
          // amount field") rather than a bare toast, and keep the sheet open
          // with the user's input intact.
          if (result.errorCode === 'would_overpay') {
            setBillFormErrors((p) => ({ ...p, amount: result.error }))
          } else {
            toast.error(result.error || 'Failed to update bill')
          }
          return
        }
        toast.success('Bill updated')
      } else if (pendingBankBsId !== null) {
        // SPRO-77: created from an untracked bank expense — create AND
        // reconcile in one server action. status is always 'partial' here
        // (SPRO-82): createBill()'s 'partial' branch uses the payment amount
        // the user actually entered as amount_paid, whether or not it equals
        // the full bill amount — the DB trigger derives the correct
        // 'paid'/'partial' status from the payment either way.
        const result = await createBillFromBankTransaction({
          bsId: pendingBankBsId,
          // Only ever true off an explicit tick in the duplicate warning. The
          // server runs the same check regardless and refuses without it.
          allowDuplicate: duplicateCandidates.length > 0 && duplicateAck,
          bill: {
            name: billForm.name.trim(),
            vendor_id: billForm.vendor_id || undefined,
            amount,
            due_date: billForm.due_date,
            status: newBillPaid ? 'partial' : 'unpaid',
            payment_method: newBillPaid ? newBillPayment.payment_method || null : undefined,
            payment_ref: newBillPaid ? newBillPayment.payment_ref.trim() || undefined : undefined,
            paid_date: newBillPaid ? newBillPayment.paid_date || null : undefined,
            amount_paid: newBillPaid ? parseFloat(newBillPayment.amount) : undefined,
            notes: billForm.notes.trim() || undefined,
          },
        })

        // Once a bill exists, drop the bank link so a second save can never
        // retry it. On an outright failure nothing was created, so the link
        // intent is kept for the retry.
        if (result.billCreated) setPendingBankBsId(null)

        // The server found an existing bill for this money. Either the
        // background check hadn't answered yet, or one appeared between opening
        // the sheet and saving. Show the same warning rather than a bare error
        // toast — the useful action is "match to that bill", not "try again".
        if (result.duplicates && result.duplicates.length > 0) {
          setDuplicateCandidates(result.duplicates)
          setDuplicateAck(false)
          toast.warning(
            result.duplicates.length === 1
              ? 'A bill for this amount already exists — review it above'
              : 'Bills for this amount already exist — review them above'
          )
          return
        }

        if (!result.success) {
          // createBillFromBankTransaction()'s return type has no errorCode —
          // a would_overpay rejection (e.g. amount typed above the bill
          // amount slipping past the client check) still lands here as a
          // plain toast rather than an inline field error.
          toast.error(result.error || 'Failed to create bill')
          return
        }
        if (result.reconciled) {
          toast.success('Bill created and matched to the bank transaction')
        } else {
          toast.warning(
            result.warning || 'Bill created, but it could not be linked to the bank transaction'
          )
        }
      } else {
        const result = await createBill({
          name: billForm.name.trim(),
          vendor_id: billForm.vendor_id || undefined,
          amount,
          due_date: billForm.due_date,
          status: recordingNewPayment ? 'partial' : 'unpaid',
          payment_method: recordingNewPayment ? newBillPayment.payment_method || null : undefined,
          payment_ref: recordingNewPayment ? newBillPayment.payment_ref.trim() || undefined : undefined,
          paid_date: recordingNewPayment ? newBillPayment.paid_date || null : undefined,
          amount_paid: recordingNewPayment ? parseFloat(newBillPayment.amount) : undefined,
          notes: billForm.notes.trim() || undefined,
          // FIX 5 (SPRO-82 adversarial review): created_by is no longer part
          // of createBill()'s input — the server derives it from its own
          // session. Every caller is requireFinance()-gated regardless, so
          // this was attribution risk, not an access-control hole, but there
          // is no reason to accept it from the client at all.
        })
        if (!result.success) {
          // FIX 4 (SPRO-82 adversarial review): createBill() deliberately
          // KEEPS the bill when the follow-up payment insert fails (see its
          // own doc comment in actions/finance.ts) — result.data is the
          // already-created bill in that case. Previously this branch just
          // toasted the error and returned with editingBill still null, so
          // clicking Save again created a SECOND bill for the same money
          // (an invisible-until-refresh duplicate). Mirror
          // createBillFromBankTransaction's own billCreated/warning pattern
          // (handled above): add the bill to local state and switch the
          // sheet into "editing that bill" mode so a retry goes through
          // updateBill()/BillPaymentsPanel instead of createBill() again —
          // the user can then never double-create by retrying.
          if (result.data) {
            const createdBill = result.data
            setBills((prev) => [...prev, createdBill])
            openEditBillSheet(createdBill)
            toast.warning(
              result.error
                ? `Bill created, but the payment could not be recorded: ${result.error}`
                : 'Bill created, but the payment could not be recorded. Retry the payment below.'
            )
            return
          }
          if (result.errorCode === 'would_overpay') {
            setNewBillPaymentErrors((p) => ({ ...p, amount: result.error }))
          } else {
            toast.error(result.error || 'Failed to create bill')
          }
          return
        }
        toast.success('Bill created')
      }
      setBillSheetOpen(false)
      // Closing programmatically doesn't fire the sheet's onOpenChange, so the
      // bank-prefill state (including any duplicate warning) is dropped here.
      clearBankPrefillState()
      fetchData()
    } catch (err) {
      console.error('Error saving bill:', err)
      toast.error('Failed to save bill')
    } finally {
      setBillSaving(false)
    }
  }

  // -----------------------------------------------------------------------
  // SPRO-77: match the bank transaction to a bill that already exists,
  // instead of creating a second one. No bill is created or edited by the
  // user here — the server pairs the two through the same guarded
  // assign_reconciliation_match() path the manual matcher uses, which also
  // applies the bank's payment figures if the bill was still unpaid.
  // -----------------------------------------------------------------------

  const handleLinkToExistingBill = async (candidate: DuplicateBillCandidate) => {
    if (pendingBankBsId === null) return

    setLinkingBillId(candidate.id)
    try {
      const result = await linkBillToBankTransaction({
        bsId: pendingBankBsId,
        billId: candidate.id,
      })

      if (!result.success) {
        toast.error(result.error || 'Failed to match the bank transaction to that bill')
        return
      }

      toast.success(`Matched to ${candidate.name}`)
      setBillSheetOpen(false)
      clearBankPrefillState()
      fetchData()
    } catch (err) {
      console.error('Error matching bank transaction to bill:', err)
      toast.error('Failed to match the bank transaction to that bill')
    } finally {
      setLinkingBillId(null)
    }
  }

  // -----------------------------------------------------------------------
  // Delete bill
  // -----------------------------------------------------------------------

  const openDeleteDialog = (bill: Bill) => {
    setDeletingBill(bill)
    setDeleteDialogOpen(true)
  }

  const handleDeleteBill = async () => {
    if (!deletingBill) return

    setDeleteInProgress(true)
    try {
      const result = await deleteBill(deletingBill.id)
      if (!result.success) {
        toast.error(result.error || 'Failed to delete bill')
        return
      }
      toast.success(`"${deletingBill.name}" deleted`)
      setDeleteDialogOpen(false)
      setBillSheetOpen(false)
      clearBankPrefillState()
      fetchData()
    } catch (err) {
      console.error('Error deleting bill:', err)
      toast.error('Failed to delete bill')
    } finally {
      setDeleteInProgress(false)
    }
  }

  // -----------------------------------------------------------------------
  // Instantiate from templates
  // -----------------------------------------------------------------------

  const openInstantiateDialog = async () => {
    setInstantiateDialogOpen(true)
    setInstantiatePreviewLoading(true)
    setInstantiatePreview(null)
    try {
      // Compute which templates would be created vs skipped
      const existingTemplateIds = new Set(
        bills.filter((b) => b.template_id).map((b) => b.template_id as string)
      )
      const toCreate = templates.filter((t) => !existingTemplateIds.has(t.id))
      const toSkip = templates.filter((t) => existingTemplateIds.has(t.id))
      setInstantiatePreview({ toCreate, toSkip })
    } catch (err) {
      console.error('Error computing instantiate preview:', err)
    } finally {
      setInstantiatePreviewLoading(false)
    }
  }

  const handleInstantiate = async () => {
    setInstantiating(true)
    try {
      const result = await instantiateBillsFromTemplates(month)
      if (!result.success) {
        toast.error(result.error || 'Failed to instantiate bills')
        return
      }
      toast.success(
        `Created ${result.created} bill${result.created !== 1 ? 's' : ''}` +
          (result.skipped > 0 ? `, skipped ${result.skipped} already existing` : '')
      )
      setInstantiateDialogOpen(false)
      fetchData()
    } catch (err) {
      console.error('Error instantiating bills:', err)
      toast.error('Failed to instantiate bills')
    } finally {
      setInstantiating(false)
    }
  }

  // -----------------------------------------------------------------------
  // Budget vs. actual data
  // -----------------------------------------------------------------------

  interface BudgetRow {
    name: string
    budgeted: number | null
    actual: number
    variance: number | null
    isVariable: boolean
    isUnplanned: boolean
    templateId: string | null
  }

  const buildBudgetRows = (): BudgetRow[] => {
    const rows: BudgetRow[] = []

    for (const bill of bills) {
      if (bill.status === 'void') continue
      if (bill.template_id && bill.template) {
        const tpl = templates.find((t) => t.id === bill.template_id)
        const isVariable = tpl ? !tpl.is_amount_fixed : false
        const budgeted = tpl?.amount ?? bill.template.amount ?? null
        rows.push({
          name: bill.name,
          budgeted: isVariable ? null : budgeted,
          actual: bill.amount,
          variance: isVariable || budgeted === null ? null : bill.amount - budgeted,
          isVariable,
          isUnplanned: false,
          templateId: bill.template_id,
        })
      } else {
        rows.push({
          name: bill.name,
          budgeted: null,
          actual: bill.amount,
          variance: null,
          isVariable: false,
          isUnplanned: true,
          templateId: null,
        })
      }
    }

    return rows
  }

  const budgetRows = buildBudgetRows()
  const totalBudgeted = budgetRows.reduce((s, r) => s + (r.budgeted ?? 0), 0)
  const totalActual = budgetRows.reduce((s, r) => s + r.actual, 0)
  const totalVariance = totalActual - totalBudgeted

  // -----------------------------------------------------------------------
  // Summaries
  // -----------------------------------------------------------------------

  const totalBills = bills.filter((b) => b.status !== 'void').reduce((s, b) => s + b.amount, 0)
  const unpaidBills = bills.filter((b) => b.status === 'unpaid' || b.status === 'partial')
  const unpaidAmount = unpaidBills.reduce((s, b) => s + (b.amount - b.amount_paid), 0)

  // -----------------------------------------------------------------------
  // Loading / auth guard
  // -----------------------------------------------------------------------

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading bills...</div>
      </div>
    )
  }

  if (!canManage) {
    return null
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Bills</h1>
          <p className="text-muted-foreground mt-1">Manage bills and payments for {getMonthLabel(month)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Month picker */}
          <Button variant="outline" size="icon" onClick={() => setMonth(prevMonth(month))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium min-w-[140px] text-center">{getMonthLabel(month)}</span>
          <Button variant="outline" size="icon" onClick={() => setMonth(nextMonth(month))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {month !== currentMonthStr() && (
            <Button variant="ghost" size="sm" onClick={() => setMonth(currentMonthStr())}>
              Today
            </Button>
          )}
          <div className="flex items-center border rounded-lg p-1">
            <Button
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('table')}
              className="px-2"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'card' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('card')}
              className="px-2"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
          <Button variant="outline" onClick={openInstantiateDialog}>
            <FileStack className="h-4 w-4 mr-2" />
            From Templates
          </Button>
          <Button onClick={openNewBillSheet}>
            <Plus className="h-4 w-4 mr-2" />
            Add Bill
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Banknote className="h-4 w-4" />
              Total Bills
            </div>
            <div className="text-2xl font-bold">{formatMoney(totalBills)}</div>
            <div className="text-xs text-muted-foreground">{bills.length} bills this month</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <AlertTriangle className="h-4 w-4" />
              Still Owed
            </div>
            <div className={`text-2xl font-bold ${unpaidAmount > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {formatMoney(unpaidAmount)}
            </div>
            <div className="text-xs text-muted-foreground">{unpaidBills.length} unpaid / partial</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <CheckCircle className="h-4 w-4" />
              Paid
            </div>
            <div className="text-2xl font-bold text-green-600">
              {formatMoney(bills.filter((b) => b.status === 'paid').reduce((s, b) => s + b.amount, 0))}
            </div>
            <div className="text-xs text-muted-foreground">
              {bills.filter((b) => b.status === 'paid').length} bills paid
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Filters</CardTitle>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {filteredBills.length} of {bills.length} bills
              </span>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3 mr-1" />
                  Clear Filters
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search bills or vendors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Status filter */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="unpaid">Unpaid</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>

            {/* Vendor filter */}
            <Popover open={vendorFilterOpen} onOpenChange={setVendorFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={vendorFilterOpen}
                  className="w-full justify-between font-normal"
                >
                  {vendorFilter !== 'all'
                    ? vendors.find((v) => v.id === vendorFilter)?.name ?? 'All vendors'
                    : 'All vendors'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search vendors..." />
                  <CommandList>
                    <CommandEmpty>No vendor found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="all"
                        onSelect={() => {
                          setVendorFilter('all')
                          setVendorFilterOpen(false)
                        }}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            vendorFilter === 'all' ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        All vendors
                      </CommandItem>
                      {vendors.map((v) => (
                        <CommandItem
                          key={v.id}
                          value={v.name}
                          onSelect={() => {
                            setVendorFilter(v.id)
                            setVendorFilterOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4',
                              vendorFilter === v.id ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {v.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </CardContent>
      </Card>

      {/* Bills list */}
      {filteredBills.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Banknote className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">
              {hasActiveFilters
                ? 'No bills match your current filters'
                : 'No bills for this month yet'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" onClick={openInstantiateDialog}>
                <FileStack className="h-4 w-4 mr-2" />
                From Templates
              </Button>
              <Button onClick={openNewBillSheet}>
                <Plus className="h-4 w-4 mr-2" />
                Add Bill
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : viewMode === 'table' ? (
        /* Table view */
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bill</TableHead>
                    <TableHead className="hidden sm:table-cell">Vendor</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden sm:table-cell">Due</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell text-right">Paid</TableHead>
                    <TableHead className="hidden sm:table-cell text-right">Remaining</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBills.map((bill) => {
                    const remaining = Math.max(bill.amount - bill.amount_paid, 0)
                    return (
                    <TableRow key={bill.id}>
                      <TableCell className="font-medium">
                        {bill.name}
                        {/* On mobile, surface vendor + due date as sub-text */}
                        <div className="sm:hidden text-xs text-muted-foreground mt-0.5 space-y-0.5">
                          {bill.vendor?.name && <span className="block">{bill.vendor.name}</span>}
                          <span className="block">Due {format(parseISO(bill.due_date), 'MMM d, yyyy')}</span>
                          {bill.amount_paid > 0 && (
                            <span className="block text-green-600">{formatMoney(bill.amount_paid)} paid</span>
                          )}
                          {bill.status !== 'void' && remaining > 0 && (
                            <span className="block text-amber-700 dark:text-amber-400">
                              {formatMoney(remaining)} remaining
                            </span>
                          )}
                        </div>
                        {bill.notes && (
                          <p className="text-xs text-muted-foreground truncate max-w-[200px] mt-0.5">{bill.notes}</p>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                        {bill.vendor?.name ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatMoney(bill.amount)}</TableCell>
                      <TableCell className="hidden sm:table-cell text-sm whitespace-nowrap">
                        {format(parseISO(bill.due_date), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        <BillStatusBadge status={bill.status} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right text-sm">
                        {bill.amount_paid > 0 ? formatMoney(bill.amount_paid) : '—'}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right text-sm">
                        {bill.status === 'void' ? '—' : formatMoney(remaining)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditBillSheet(bill)}>
                              <Edit2 className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => openDeleteDialog(bill)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* Card view — mobile */
        <div className="space-y-3">
          {filteredBills.map((bill) => {
            const remaining = Math.max(bill.amount - bill.amount_paid, 0)
            return (
            <Card key={bill.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold">{bill.name}</p>
                      <BillStatusBadge status={bill.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                      {bill.vendor?.name && <span>{bill.vendor.name}</span>}
                      <span>Due {format(parseISO(bill.due_date), 'MMM d, yyyy')}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span className="font-semibold">{formatMoney(bill.amount)}</span>
                      {bill.amount_paid > 0 && (
                        <span className="text-green-600">{formatMoney(bill.amount_paid)} paid</span>
                      )}
                      {bill.status !== 'void' && remaining > 0 && (
                        <span className="text-amber-700 dark:text-amber-400">
                          {formatMoney(remaining)} remaining
                        </span>
                      )}
                    </div>
                    {bill.notes && (
                      <p className="text-xs text-muted-foreground mt-1">{bill.notes}</p>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEditBillSheet(bill)}>
                        <Edit2 className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => openDeleteDialog(bill)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
            )
          })}
        </div>
      )}

      {/* Budget vs. Actual */}
      <Collapsible open={budgetOpen} onOpenChange={setBudgetOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <span className="flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Budget vs. Actual
            </span>
            {budgetOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className="mt-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Budget vs. Actual — {getMonthLabel(month)}</CardTitle>
              <p className="text-xs text-muted-foreground">
                Compares template (budgeted) amounts against actual bills.
                Variable-amount templates show &quot;Variable&quot;; one-off bills show &quot;Unplanned&quot;.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bill</TableHead>
                      <TableHead className="hidden sm:table-cell text-right">Budgeted</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {budgetRows.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium text-sm">
                          {row.name}
                          {row.isUnplanned && (
                            <Badge variant="outline" className="ml-2 text-xs">Unplanned</Badge>
                          )}
                          {/* Mobile: show budgeted amount as sub-text */}
                          <div className="sm:hidden text-xs text-muted-foreground mt-0.5">
                            {row.isVariable ? (
                              <span className="italic">Budget: Variable</span>
                            ) : row.budgeted !== null ? (
                              <span>Budget: {formatMoney(row.budgeted)}</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-right text-sm">
                          {row.isVariable ? (
                            <span className="text-muted-foreground italic">Variable</span>
                          ) : row.budgeted !== null ? (
                            formatMoney(row.budgeted)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">{formatMoney(row.actual)}</TableCell>
                        <TableCell className="text-right text-sm">
                          {row.variance === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : row.variance === 0 ? (
                            <span className="text-muted-foreground">On budget</span>
                          ) : row.variance > 0 ? (
                            <span className="text-red-600">+{formatMoney(row.variance)} over</span>
                          ) : (
                            <span className="text-green-600">{formatMoney(row.variance)} under</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {/* Totals row */}
                  <TableBody>
                    <TableRow className="border-t-2 bg-muted/30 font-semibold">
                      <TableCell>
                        Total
                        <div className="sm:hidden text-xs font-normal text-muted-foreground mt-0.5">
                          Budget: {formatMoney(totalBudgeted)}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right">{formatMoney(totalBudgeted)}</TableCell>
                      <TableCell className="text-right">{formatMoney(totalActual)}</TableCell>
                      <TableCell className="text-right">
                        {totalVariance === 0 ? (
                          <span className="text-muted-foreground">On budget</span>
                        ) : totalVariance > 0 ? (
                          <span className="text-red-600">+{formatMoney(totalVariance)} over</span>
                        ) : (
                          <span className="text-green-600">{formatMoney(totalVariance)} under</span>
                        )}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {/* Add / Edit Bill Sheet */}
      <Sheet open={billSheetOpen} onOpenChange={handleBillSheetOpenChange}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingBill ? 'Edit Bill' : 'Add Bill'}</SheetTitle>
            <SheetDescription>
              {editingBill ? `Editing bill for ${getMonthLabel(month)}` : `New one-off bill for ${getMonthLabel(month)}`}
            </SheetDescription>
          </SheetHeader>

          {/* SPRO-77 duplicate warning — scrolls with the form (the sheet body
              is the scroll container), never fixed, so it can't push the fields
              off-screen on a phone. */}
          {duplicateCandidates.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {duplicateCandidates.length === 1
                      ? 'A bill for this amount already exists'
                      : `${duplicateCandidates.length} bills for this amount already exist`}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    Match this bank transaction to one of them instead of recording the same
                    money twice.
                  </p>
                </div>
              </div>

              <ul className="mt-2.5 space-y-2">
                {duplicateCandidates.map((c) => (
                  <li
                    key={c.id}
                    className="rounded border border-amber-200 dark:border-amber-900 bg-background/70 p-2"
                  >
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {c.vendor_name ?? 'No vendor'} &middot; {formatMoney(c.amount)} &middot; Due{' '}
                      {format(parseISO(c.due_date), 'MMM d, yyyy')} &middot; {c.status}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 w-full text-xs border-amber-400 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                      onClick={() => handleLinkToExistingBill(c)}
                      disabled={billSaving || linkingBillId !== null}
                    >
                      {linkingBillId === c.id ? 'Matching...' : 'Match to this bill'}
                    </Button>
                  </li>
                ))}
              </ul>

              <label
                htmlFor="duplicate-ack"
                className="mt-2.5 flex items-start gap-2 cursor-pointer"
              >
                <Checkbox
                  id="duplicate-ack"
                  checked={duplicateAck}
                  onCheckedChange={(v) => setDuplicateAck(v === true)}
                  disabled={billSaving || linkingBillId !== null}
                  className="mt-0.5 border-amber-500 data-[state=checked]:bg-amber-600"
                />
                <span className="text-xs text-amber-800 dark:text-amber-300">
                  This is a separate bill — create it anyway
                </span>
              </label>
            </div>
          )}

          <div className="space-y-4 pt-6">
            <div className="space-y-2">
              <Label htmlFor="bill-name">Bill Name</Label>
              <Input
                id="bill-name"
                placeholder="e.g. Rent, Internet, Payroll"
                value={billForm.name}
                onChange={(e) => {
                  setBillForm((p) => ({ ...p, name: e.target.value }))
                  if (billFormErrors.name) setBillFormErrors((p) => ({ ...p, name: undefined }))
                }}
                className={cn(billFormErrors.name && 'border-red-500')}
              />
              {billFormErrors.name && (
                <p className="text-red-500 text-xs mt-1">{billFormErrors.name}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Vendor (optional)</Label>
              <VendorCombobox
                vendors={vendors}
                value={billForm.vendor_id}
                onChange={(vendorId) => setBillForm((p) => ({ ...p, vendor_id: vendorId }))}
                disabled={billSaving}
                placeholder="No vendor"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bill-amount">Amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <Input
                  id="bill-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={billForm.amount}
                  onChange={(e) => {
                    setBillForm((p) => ({ ...p, amount: e.target.value }))
                    if (billFormErrors.amount) setBillFormErrors((p) => ({ ...p, amount: undefined }))
                  }}
                  className={cn('pl-7', billFormErrors.amount && 'border-red-500')}
                />
              </div>
              {billFormErrors.amount && (
                <p className="text-red-500 text-xs mt-1">{billFormErrors.amount}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bill-due">Due Date</Label>
              <Input
                id="bill-due"
                type="date"
                value={billForm.due_date}
                onChange={(e) => {
                  setBillForm((p) => ({ ...p, due_date: e.target.value }))
                  if (billFormErrors.due_date) setBillFormErrors((p) => ({ ...p, due_date: undefined }))
                }}
                className={cn(billFormErrors.due_date && 'border-red-500')}
              />
              {billFormErrors.due_date && (
                <p className="text-red-500 text-xs mt-1">{billFormErrors.due_date}</p>
              )}
            </div>

            {/* SPRO-82: status is derived from the payment ledger by a DB
                trigger — read-only badge, not an editable field. Voiding is
                its own action (setBillVoid), separate from payments. */}
            {editingBill && (
              <div className="space-y-2">
                <Label>Status</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <BillStatusBadge status={editingBill.status} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={billSaving || voidToggling}
                    onClick={handleToggleVoid}
                  >
                    {voidToggling
                      ? 'Updating...'
                      : editingBill.status === 'void'
                        ? 'Un-void Bill'
                        : 'Void Bill'}
                  </Button>
                </div>
              </div>
            )}

            {/* SPRO-82: a bill can hold several payments now — this section
                replaces the old single status/payment-method/amount-paid
                fields above. */}
            {editingBill && (
              <BillPaymentsPanel
                bill={editingBill}
                disabled={billSaving}
                onPaymentsChanged={refreshAfterPaymentChange}
              />
            )}

            {/* New bill only: a simple optional "already paid" shortcut that
                records ONE payment on save, so a bill entered after the fact
                (or prefilled from an untracked bank expense, SPRO-77) doesn't
                need a separate "add payment" step right after creation.
                Editing an existing bill's payments always goes through
                BillPaymentsPanel above instead. */}
            {!editingBill && (
              <div className="space-y-3 rounded-md border p-3">
                <label htmlFor="new-bill-paid" className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    id="new-bill-paid"
                    checked={newBillPaid}
                    onCheckedChange={(v) => {
                      const checked = v === true
                      setNewBillPaid(checked)
                      if (checked) {
                        setNewBillPayment((p) => ({
                          ...p,
                          amount: p.amount || billForm.amount,
                        }))
                      } else {
                        setNewBillPaymentErrors({})
                      }
                    }}
                  />
                  <span className="text-sm font-medium">Already paid</span>
                </label>

                {newBillPaid && (
                  <div className="space-y-3 pl-1">
                    <PaymentFormFields
                      idPrefix="new-bill-payment"
                      form={newBillPayment}
                      setForm={setNewBillPayment}
                      errors={newBillPaymentErrors}
                      setErrors={setNewBillPaymentErrors}
                      disabled={billSaving}
                      hideNotes
                    />
                    {newBillPaymentErrors.amount === undefined &&
                      billForm.amount &&
                      newBillPayment.amount &&
                      !isNaN(parseFloat(newBillPayment.amount)) &&
                      !isNaN(parseFloat(billForm.amount)) &&
                      parseFloat(newBillPayment.amount) < parseFloat(billForm.amount) && (
                        <p className="text-xs text-muted-foreground">
                          Balance remaining: {formatMoney(parseFloat(billForm.amount) - parseFloat(newBillPayment.amount))}
                        </p>
                      )}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="bill-notes">Notes (optional)</Label>
              <Textarea
                id="bill-notes"
                placeholder="Any details about this bill..."
                value={billForm.notes}
                onChange={(e) => setBillForm((p) => ({ ...p, notes: e.target.value }))}
                rows={3}
              />
            </div>

            {/* Creating anyway stays possible — two identical bills in a month
                is legitimate — but it has to be deliberate. */}
            {duplicateCandidates.length > 0 && !duplicateAck && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Match to an existing bill above, or tick &quot;create it anyway&quot; to record a
                second one.
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                className="flex-1"
                onClick={handleSaveBill}
                disabled={
                  billSaving ||
                  linkingBillId !== null ||
                  duplicateChecking ||
                  (duplicateCandidates.length > 0 && !duplicateAck)
                }
              >
                {billSaving ? 'Saving...' : editingBill ? 'Save Changes' : 'Create Bill'}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleBillSheetOpenChange(false)}
                disabled={billSaving || linkingBillId !== null}
              >
                Cancel
              </Button>
            </div>

            {editingBill && (
              <div className="pt-2 border-t">
                <Button
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => openDeleteDialog(editingBill)}
                  disabled={billSaving}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Bill
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Bill Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bill?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingBill && (
                <>
                  This will permanently delete <strong>{deletingBill.name}</strong> ({formatMoney(deletingBill.amount)}).
                  {deletingBill.status === 'paid' && ' This bill has already been marked as paid.'}
                  {' '}This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteInProgress}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteBill}
              disabled={deleteInProgress}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteInProgress ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Instantiate from Templates Dialog */}
      <AlertDialog open={instantiateDialogOpen} onOpenChange={setInstantiateDialogOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Instantiate Bills from Templates</AlertDialogTitle>
            <AlertDialogDescription>
              Creates bills for {getMonthLabel(month)} from all active bill templates. Already-existing bills are skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {instantiatePreviewLoading ? (
            <div className="py-4 text-center text-muted-foreground text-sm">Loading preview...</div>
          ) : instantiatePreview ? (
            <div className="space-y-4 py-2">
              {instantiatePreview.toCreate.length > 0 ? (
                <div>
                  <p className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                    Will create ({instantiatePreview.toCreate.length}):
                  </p>
                  <ul className="text-sm space-y-1">
                    {instantiatePreview.toCreate.map((t) => (
                      <li key={t.id} className="flex justify-between">
                        <span>{t.name}</span>
                        <span className="text-muted-foreground">
                          {t.is_amount_fixed && t.amount != null
                            ? formatMoney(t.amount)
                            : 'Variable'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">All templates already have bills for this month.</p>
              )}

              {instantiatePreview.toSkip.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Already exists — will skip ({instantiatePreview.toSkip.length}):
                  </p>
                  <ul className="text-sm space-y-1 text-muted-foreground">
                    {instantiatePreview.toSkip.map((t) => (
                      <li key={t.id}>{t.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={instantiating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleInstantiate}
              disabled={instantiating || (instantiatePreview?.toCreate.length === 0)}
            >
              {instantiating
                ? 'Creating...'
                : `Create ${instantiatePreview?.toCreate.length ?? 0} Bill${(instantiatePreview?.toCreate.length ?? 0) !== 1 ? 's' : ''}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
