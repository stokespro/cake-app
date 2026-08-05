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
  instantiateBillsFromTemplates,
  getBillsForMonth,
  getTemplatesWithVendors,
  getVendors,
} from '@/actions/finance'
import type { Bill, BillStatus, BillTemplate, Vendor } from '@/actions/finance'
import { createBillFromBankTransaction } from '@/app/dashboard/finance/_actions/bank'
import { derivePrefillPayment } from '@/app/dashboard/finance/_lib/bank-prefill'
import { VendorCombobox } from '@/components/finance/vendor-combobox'

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

interface BillFormData {
  name: string
  vendor_id: string
  amount: string
  due_date: string
  status: BillStatus
  payment_method: string
  payment_ref: string
  paid_date: string
  amount_paid: string
  notes: string
}

interface BillFormErrors {
  name?: string
  amount?: string
  due_date?: string
  payment_method?: string
  payment_ref?: string
  paid_date?: string
  amount_paid?: string
}

const PAYMENT_METHODS = [
  { value: 'card', label: 'Debit Card' },
  { value: 'ach', label: 'ACH' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
]

const BILL_STATUSES: { value: BillStatus; label: string }[] = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partial', label: 'Partial' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
]

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
    status: 'unpaid',
    payment_method: '',
    payment_ref: '',
    paid_date: new Date().toISOString().substring(0, 10),
    amount_paid: '',
    notes: '',
  })
  const [billSaving, setBillSaving] = useState(false)
  const [billFormErrors, setBillFormErrors] = useState<BillFormErrors>({})

  // SPRO-77: set when the create sheet was opened from an untracked bank
  // expense (Finance overview → "Create Bill"). While set, saving a NEW bill
  // goes through createBillFromBankTransaction() so the bill is also
  // reconciled against that bank transaction. Cleared as soon as an attempt
  // has been made, and by openNewBillSheet(), so a later manual bill can never
  // be wrongly reconciled.
  const [pendingBankBsId, setPendingBankBsId] = useState<number | null>(null)

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
      status: 'paid',           // the money has already left the bank
      payment_method,
      payment_ref,
      paid_date: dueDate || new Date().toISOString().substring(0, 10),
      amount_paid: '',
      notes: memo,
    })
    setBillFormErrors({})
    setPendingBankBsId(Number.isFinite(bsId) ? bsId : null)
    setBillSheetOpen(true)

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

  const openNewBillSheet = () => {
    setEditingBill(null)
    // Never carry a bank link over into a manually-started bill.
    setPendingBankBsId(null)
    setBillForm({
      name: '',
      vendor_id: '',
      amount: '',
      due_date: '',
      status: 'unpaid',
      payment_method: '',
      payment_ref: '',
      paid_date: new Date().toISOString().substring(0, 10),
      amount_paid: '',
      notes: '',
    })
    setBillFormErrors({})
    setBillSheetOpen(true)
  }

  const openEditBillSheet = (bill: Bill) => {
    setEditingBill(bill)
    // Defence in depth: the edit path never reads pendingBankBsId, but an
    // abandoned prefill must not survive into any other save.
    setPendingBankBsId(null)
    setBillForm({
      name: bill.name,
      vendor_id: bill.vendor_id ?? '',
      amount: String(bill.amount),
      due_date: bill.due_date,
      status: bill.status,
      payment_method: bill.payment_method ?? '',
      payment_ref: bill.payment_ref ?? '',
      paid_date: bill.paid_date ?? new Date().toISOString().substring(0, 10),
      amount_paid: bill.amount_paid > 0 ? String(bill.amount_paid) : '',
      notes: bill.notes ?? '',
    })
    setBillFormErrors({})
    setBillSheetOpen(true)
  }

  const handleSaveBill = async () => {
    const amount = parseFloat(billForm.amount)
    const needsPayment = billForm.status === 'paid' || billForm.status === 'partial'

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

    if (needsPayment) {
      if (!billForm.payment_method) {
        errors.payment_method = 'Payment method is required'
      }
      if (billForm.payment_method === 'check' && !billForm.payment_ref.trim()) {
        errors.payment_ref = 'Check number is required when paying by check'
      }
      if (!billForm.paid_date) {
        errors.paid_date = 'Payment date is required'
      }
      if (billForm.status === 'partial') {
        const amtPaid = parseFloat(billForm.amount_paid)
        if (isNaN(amtPaid) || amtPaid <= 0) {
          errors.amount_paid = 'Amount paid must be greater than 0'
        } else if (!isNaN(amount) && amtPaid >= amount) {
          errors.amount_paid = 'Amount paid must be less than the bill amount'
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      setBillFormErrors(errors)
      toast.error('Please fix the highlighted fields')
      return
    }

    setBillFormErrors({})

    setBillSaving(true)
    try {
      if (editingBill) {
        const result = await updateBill(editingBill.id, {
          name: billForm.name.trim(),
          vendor_id: billForm.vendor_id || null,
          amount,
          due_date: billForm.due_date,
          status: billForm.status,
          payment_method: needsPayment ? billForm.payment_method || null : null,
          payment_ref: needsPayment ? billForm.payment_ref.trim() || null : null,
          paid_date: needsPayment ? billForm.paid_date || null : null,
          amount_paid: needsPayment && billForm.status === 'partial'
            ? parseFloat(billForm.amount_paid)
            : needsPayment && billForm.status === 'paid'
              ? amount
              : undefined,
          notes: billForm.notes.trim() || null,
        })
        if (!result.success) {
          toast.error(result.error || 'Failed to update bill')
          return
        }
        toast.success('Bill updated')
      } else if (pendingBankBsId !== null) {
        // SPRO-77: created from an untracked bank expense — create AND
        // reconcile in one server action. Same field mapping as the plain
        // create below (createBill derives the full amount_paid for 'paid';
        // only 'partial' passes an explicit amount_paid).
        const result = await createBillFromBankTransaction({
          bsId: pendingBankBsId,
          bill: {
            name: billForm.name.trim(),
            vendor_id: billForm.vendor_id || undefined,
            amount,
            due_date: billForm.due_date,
            status: billForm.status,
            payment_method: needsPayment ? billForm.payment_method || null : undefined,
            payment_ref: needsPayment ? billForm.payment_ref.trim() || undefined : undefined,
            paid_date: needsPayment ? billForm.paid_date || null : undefined,
            amount_paid: needsPayment && billForm.status === 'partial'
              ? parseFloat(billForm.amount_paid)
              : undefined,
            notes: billForm.notes.trim() || undefined,
          },
        })

        // Once a bill exists, drop the bank link so a second save can never
        // retry it. On an outright failure nothing was created, so the link
        // intent is kept for the retry.
        if (result.billCreated) setPendingBankBsId(null)

        if (!result.success) {
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
          status: billForm.status,
          payment_method: needsPayment ? billForm.payment_method || null : undefined,
          payment_ref: needsPayment ? billForm.payment_ref.trim() || undefined : undefined,
          paid_date: needsPayment ? billForm.paid_date || null : undefined,
          amount_paid: needsPayment && billForm.status === 'partial'
            ? parseFloat(billForm.amount_paid)
            : undefined,
          notes: billForm.notes.trim() || undefined,
          created_by: user?.id,
        })
        if (!result.success) {
          toast.error(result.error || 'Failed to create bill')
          return
        }
        toast.success('Bill created')
      }
      setBillSheetOpen(false)
      fetchData()
    } catch (err) {
      console.error('Error saving bill:', err)
      toast.error('Failed to save bill')
    } finally {
      setBillSaving(false)
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
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBills.map((bill) => (
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
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* Card view — mobile */
        <div className="space-y-3">
          {filteredBills.map((bill) => (
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
                    <div className="mt-2 flex items-center gap-4 text-sm">
                      <span className="font-semibold">{formatMoney(bill.amount)}</span>
                      {bill.amount_paid > 0 && (
                        <span className="text-green-600">{formatMoney(bill.amount_paid)} paid</span>
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
          ))}
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
      <Sheet open={billSheetOpen} onOpenChange={setBillSheetOpen}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingBill ? 'Edit Bill' : 'Add Bill'}</SheetTitle>
            <SheetDescription>
              {editingBill ? `Editing bill for ${getMonthLabel(month)}` : `New one-off bill for ${getMonthLabel(month)}`}
            </SheetDescription>
          </SheetHeader>

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

            <div className="space-y-2">
              <Label htmlFor="bill-status">Status</Label>
              <Select
                value={billForm.status}
                onValueChange={(v) => {
                  const newStatus = v as BillStatus
                  // Clear payment fields when switching away from paid/partial
                  if (newStatus !== 'paid' && newStatus !== 'partial') {
                    setBillForm((p) => ({
                      ...p,
                      status: newStatus,
                      payment_method: '',
                      payment_ref: '',
                      paid_date: new Date().toISOString().substring(0, 10),
                      amount_paid: '',
                    }))
                    setBillFormErrors((p) => ({
                      ...p,
                      payment_method: undefined,
                      payment_ref: undefined,
                      paid_date: undefined,
                      amount_paid: undefined,
                    }))
                  } else {
                    setBillForm((p) => ({ ...p, status: newStatus }))
                  }
                }}
              >
                <SelectTrigger id="bill-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILL_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Payment fields — shown only when status = paid or partial */}
            {(billForm.status === 'paid' || billForm.status === 'partial') && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="bill-payment-method">Payment Method *</Label>
                  <Select
                    value={billForm.payment_method || ''}
                    onValueChange={(v) => {
                      setBillForm((p) => ({ ...p, payment_method: v }))
                      if (billFormErrors.payment_method) setBillFormErrors((p) => ({ ...p, payment_method: undefined }))
                      // Also clear check number error if switching away from check
                      if (v !== 'check' && billFormErrors.payment_ref) setBillFormErrors((p) => ({ ...p, payment_ref: undefined }))
                    }}
                  >
                    <SelectTrigger
                      id="bill-payment-method"
                      className={cn(billFormErrors.payment_method && 'border-red-500')}
                    >
                      <SelectValue placeholder="Select method (required)" />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {billFormErrors.payment_method && (
                    <p className="text-red-500 text-xs mt-1">{billFormErrors.payment_method}</p>
                  )}
                </div>

                {billForm.payment_method === 'check' && (
                  <div className="space-y-2">
                    <Label htmlFor="bill-check-number">Check Number *</Label>
                    <Input
                      id="bill-check-number"
                      placeholder="e.g. 1234"
                      value={billForm.payment_ref}
                      onChange={(e) => {
                        setBillForm((p) => ({ ...p, payment_ref: e.target.value }))
                        if (billFormErrors.payment_ref) setBillFormErrors((p) => ({ ...p, payment_ref: undefined }))
                      }}
                      className={cn(billFormErrors.payment_ref && 'border-red-500')}
                    />
                    {billFormErrors.payment_ref && (
                      <p className="text-red-500 text-xs mt-1">{billFormErrors.payment_ref}</p>
                    )}
                  </div>
                )}

                {billForm.payment_method && billForm.payment_method !== 'check' && (
                  <div className="space-y-2">
                    <Label htmlFor="bill-payment-ref">Reference (optional)</Label>
                    <Input
                      id="bill-payment-ref"
                      placeholder="e.g. ACH ref, last 4..."
                      value={billForm.payment_ref}
                      onChange={(e) => setBillForm((p) => ({ ...p, payment_ref: e.target.value }))}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="bill-paid-date">Payment Date *</Label>
                  <Input
                    id="bill-paid-date"
                    type="date"
                    value={billForm.paid_date}
                    onChange={(e) => {
                      setBillForm((p) => ({ ...p, paid_date: e.target.value }))
                      if (billFormErrors.paid_date) setBillFormErrors((p) => ({ ...p, paid_date: undefined }))
                    }}
                    className={cn(billFormErrors.paid_date && 'border-red-500')}
                  />
                  {billFormErrors.paid_date && (
                    <p className="text-red-500 text-xs mt-1">{billFormErrors.paid_date}</p>
                  )}
                </div>

                {billForm.status === 'partial' && (
                  <div className="space-y-2">
                    <Label htmlFor="bill-amount-paid">Amount Paid *</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                      <Input
                        id="bill-amount-paid"
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="0.00"
                        value={billForm.amount_paid}
                        onChange={(e) => {
                          setBillForm((p) => ({ ...p, amount_paid: e.target.value }))
                          if (billFormErrors.amount_paid) setBillFormErrors((p) => ({ ...p, amount_paid: undefined }))
                        }}
                        className={cn('pl-7', billFormErrors.amount_paid && 'border-red-500')}
                      />
                    </div>
                    {billFormErrors.amount_paid ? (
                      <p className="text-red-500 text-xs mt-1">{billFormErrors.amount_paid}</p>
                    ) : (
                      billForm.amount && billForm.amount_paid && !isNaN(parseFloat(billForm.amount_paid)) && !isNaN(parseFloat(billForm.amount)) && parseFloat(billForm.amount_paid) < parseFloat(billForm.amount) && (
                        <p className="text-xs text-muted-foreground">
                          Balance remaining: {formatMoney(parseFloat(billForm.amount) - parseFloat(billForm.amount_paid))}
                        </p>
                      )
                    )}
                  </div>
                )}

                {billForm.status === 'paid' && billForm.amount && (
                  <p className="text-xs text-muted-foreground">
                    Full amount {formatMoney(parseFloat(billForm.amount) || 0)} will be recorded as paid.
                  </p>
                )}
              </>
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

            <div className="flex gap-2 pt-2">
              <Button className="flex-1" onClick={handleSaveBill} disabled={billSaving}>
                {billSaving ? 'Saving...' : editingBill ? 'Save Changes' : 'Create Bill'}
              </Button>
              <Button variant="outline" onClick={() => setBillSheetOpen(false)} disabled={billSaving}>
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
