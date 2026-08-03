'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
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
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { toast } from 'sonner'
import {
  DollarSign,
  Download,
  CalendarIcon,
  MoreVertical,
  CheckCircle,
  Clock,
  Banknote,
  FileText,
  Filter,
  Edit2,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { format } from 'date-fns'
import { cn, parseLocalDate } from '@/lib/utils'
import type { CommissionStatus } from '@/types/database'
import {
  getCommissions,
  getSalespeople,
  getOrderDetailForAdmin,
  approveCommission,
  markCommissionPaid,
  saveCommissionNote,
  bulkMarkCommissionsPaid,
  revertCommissionStatus,
  type CommissionRow,
  type SalespersonOption,
  type OrderDetail,
  type CommissionBreakdownItem,
} from '@/actions/commissions'

interface FilterState {
  dateFrom: string
  dateTo: string
  salespersonId: string
  status: string
}

const initialFilters: FilterState = {
  dateFrom: '',
  dateTo: '',
  salespersonId: '',
  status: 'all',
}

export default function CommissionsPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  const [commissions, setCommissions] = useState<CommissionRow[]>([])
  const [filteredCommissions, setFilteredCommissions] = useState<CommissionRow[]>([])
  const [salespeople, setSalespeople] = useState<SalespersonOption[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<FilterState>(initialFilters)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Sheet state for actions
  const [actionSheetOpen, setActionSheetOpen] = useState(false)
  const [actionCommission, setActionCommission] = useState<CommissionRow | null>(null)
  const [actionType, setActionType] = useState<'approve' | 'pay' | 'note'>('approve')
  const [paidDate, setPaidDate] = useState<Date | undefined>(new Date())
  const [noteText, setNoteText] = useState('')
  const [saving, setSaving] = useState(false)

  // Order detail sheet state
  const [selectedCommission, setSelectedCommission] = useState<CommissionRow | null>(null)
  const [orderDetailOpen, setOrderDetailOpen] = useState(false)
  const [orderDetail, setOrderDetail] = useState<{ order: OrderDetail; breakdown: CommissionBreakdownItem[] } | null>(null)
  const [orderDetailLoading, setOrderDetailLoading] = useState(false)

  // Bulk action dialog
  const [bulkPayDialogOpen, setBulkPayDialogOpen] = useState(false)
  const [bulkPaidDate, setBulkPaidDate] = useState<Date | undefined>(new Date())
  const [bulkSaving, setBulkSaving] = useState(false)

  // Revert status dialog (undo an accidental approve/pay)
  const [revertDialogOpen, setRevertDialogOpen] = useState(false)
  const [revertCommission, setRevertCommission] = useState<CommissionRow | null>(null)
  const [revertTarget, setRevertTarget] = useState<'pending' | 'approved'>('pending')
  const [reverting, setReverting] = useState(false)

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
  }, [canManage])

  useEffect(() => {
    filterCommissions()
  }, [commissions, filters])

  const fetchData = async () => {
    try {
      const [commissionsResult, salespeopleResult] = await Promise.all([
        getCommissions(),
        getSalespeople(),
      ])

      if (commissionsResult.error) throw new Error(commissionsResult.error)
      if (salespeopleResult.error) throw new Error(salespeopleResult.error)

      setCommissions(commissionsResult.data ?? [])
      setSalespeople(salespeopleResult.data ?? [])
    } catch (error) {
      console.error('Error fetching data:', error)
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const fetchOrderDetail = async (commission: CommissionRow) => {
    setSelectedCommission(commission)
    setOrderDetailOpen(true)
    setOrderDetailLoading(true)
    try {
      const result = await getOrderDetailForAdmin(commission.order_id, commission.salesperson_id)
      if (result.error) throw new Error(result.error)
      if (result.order) {
        setOrderDetail({ order: result.order, breakdown: result.breakdown ?? [] })
      }
    } catch (error) {
      console.error('Error fetching order detail:', error)
    } finally {
      setOrderDetailLoading(false)
    }
  }

  const filterCommissions = useCallback(() => {
    let filtered = [...commissions]

    // Filter by date range
    if (filters.dateFrom) {
      const fromDate = new Date(filters.dateFrom + 'T00:00:00')
      filtered = filtered.filter(c => parseLocalDate(c.order_date) >= fromDate)
    }
    if (filters.dateTo) {
      const toDate = new Date(filters.dateTo + 'T23:59:59')
      filtered = filtered.filter(c => parseLocalDate(c.order_date) <= toDate)
    }

    // Filter by salesperson
    if (filters.salespersonId && filters.salespersonId !== 'all') {
      filtered = filtered.filter(c => c.salesperson_id === filters.salespersonId)
    }

    // Filter by status
    if (filters.status && filters.status !== 'all') {
      filtered = filtered.filter(c => c.status === filters.status)
    }

    setFilteredCommissions(filtered)
  }, [commissions, filters])

  const updateFilters = (newFilters: Partial<FilterState>) => {
    setFilters(prev => ({ ...prev, ...newFilters }))
  }

  const clearFilters = () => {
    setFilters(initialFilters)
  }

  const hasActiveFilters = filters.dateFrom || filters.dateTo ||
    (filters.salespersonId && filters.salespersonId !== 'all') ||
    (filters.status && filters.status !== 'all')

  // Summary calculations
  const totalPending = filteredCommissions
    .filter(c => c.status === 'pending')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  const totalApproved = filteredCommissions
    .filter(c => c.status === 'approved')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  const totalPaid = filteredCommissions
    .filter(c => c.status === 'paid')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  // Selection handlers
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredCommissions.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredCommissions.map(c => c.id)))
    }
  }

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  // Action handlers
  const openActionSheet = (commission: CommissionRow, type: 'approve' | 'pay' | 'note') => {
    setActionCommission(commission)
    setActionType(type)
    setNoteText(commission.notes || '')
    setPaidDate(new Date())
    setActionSheetOpen(true)
  }

  const handleApprove = async () => {
    if (!actionCommission) return
    setSaving(true)
    try {
      const result = await approveCommission(actionCommission.id)
      if (result.error) throw new Error(result.error)
      toast.success('Commission approved')
      setActionSheetOpen(false)
      fetchData()
    } catch (error) {
      console.error('Error approving commission:', error)
      toast.error('Failed to approve commission')
    } finally {
      setSaving(false)
    }
  }

  const handleMarkPaid = async () => {
    if (!actionCommission || !paidDate) return
    setSaving(true)
    try {
      const result = await markCommissionPaid(actionCommission.id, format(paidDate, 'yyyy-MM-dd'))
      if (result.error) throw new Error(result.error)
      toast.success('Commission marked as paid')
      setActionSheetOpen(false)
      fetchData()
    } catch (error) {
      console.error('Error marking commission as paid:', error)
      toast.error('Failed to mark commission as paid')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveNote = async () => {
    if (!actionCommission) return
    setSaving(true)
    try {
      const result = await saveCommissionNote(actionCommission.id, noteText)
      if (result.error) throw new Error(result.error)
      toast.success('Note saved')
      setActionSheetOpen(false)
      fetchData()
    } catch (error) {
      console.error('Error saving note:', error)
      toast.error('Failed to save note')
    } finally {
      setSaving(false)
    }
  }

  // Revert status handlers
  const performRevert = async (commission: CommissionRow, targetStatus: 'pending' | 'approved') => {
    setReverting(true)
    try {
      const result = await revertCommissionStatus(commission.id, targetStatus)
      if (result.error) throw new Error(result.error)
      toast.success(`Commission reverted to ${targetStatus}`)
      setRevertDialogOpen(false)
      setRevertCommission(null)
      fetchData()
    } catch (error) {
      console.error('Error reverting commission:', error)
      toast.error('Failed to revert commission')
    } finally {
      setReverting(false)
    }
  }

  const handleRevertClick = (commission: CommissionRow, targetStatus: 'pending' | 'approved') => {
    // Reverting a PAID commission is the most consequential action — confirm first.
    // Approved -> pending is lower stakes and doesn't touch payment info.
    if (commission.status === 'paid') {
      setRevertCommission(commission)
      setRevertTarget(targetStatus)
      setRevertDialogOpen(true)
    } else {
      performRevert(commission, targetStatus)
    }
  }

  const handleConfirmRevert = () => {
    if (!revertCommission) return
    performRevert(revertCommission, revertTarget)
  }

  // Bulk pay handler
  const handleBulkPay = async () => {
    if (selectedIds.size === 0 || !bulkPaidDate) return
    setBulkSaving(true)
    try {
      const result = await bulkMarkCommissionsPaid(
        Array.from(selectedIds),
        format(bulkPaidDate, 'yyyy-MM-dd')
      )
      if (result.error) throw new Error(result.error)
      toast.success(`${selectedIds.size} commissions marked as paid`)
      setBulkPayDialogOpen(false)
      setSelectedIds(new Set())
      fetchData()
    } catch (error) {
      console.error('Error bulk marking as paid:', error)
      toast.error('Failed to mark commissions as paid')
    } finally {
      setBulkSaving(false)
    }
  }

  // CSV Export
  const exportToCSV = () => {
    const headers = [
      'Order #',
      'Commission Date',
      'Salesperson',
      'Customer',
      'Order Total',
      'Rate %',
      'Commission',
      'Status',
      'Paid Date',
      'Notes',
    ]

    const rows = filteredCommissions.map(c => [
      c.order?.order_number || '',
      format(parseLocalDate(c.order_date), 'yyyy-MM-dd'),
      c.salesperson?.full_name || '',
      c.order?.customer?.business_name || '',
      c.order_total.toFixed(2),
      c.rate_applied.toFixed(2),
      c.commission_amount.toFixed(2),
      c.status,
      c.paid_at ? format(parseLocalDate(c.paid_at), 'yyyy-MM-dd') : '',
      (c.notes || '').replace(/"/g, '""'),
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `commissions_${format(new Date(), 'yyyy-MM-dd')}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const getStatusBadge = (status: CommissionStatus) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
      case 'approved':
        return <Badge variant="default" className="bg-blue-600"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>
      case 'paid':
        return <Badge variant="default" className="bg-green-600"><Banknote className="h-3 w-3 mr-1" />Paid</Badge>
      default:
        return null
    }
  }

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!canManage) {
    return null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Commission Reports</h1>
          <p className="text-muted-foreground mt-1">Track and manage salesperson commissions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Total Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">${totalPending.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Total Approved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-blue-600">${totalApproved.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Total Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">${totalPaid.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Filters
            </CardTitle>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {filteredCommissions.length} of {commissions.length} commissions
              </span>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear Filters
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <Input
                type="date"
                placeholder="From"
                value={filters.dateFrom}
                onChange={(e) => updateFilters({ dateFrom: e.target.value })}
                className="h-10"
              />
            </div>
            <div>
              <Input
                type="date"
                placeholder="To"
                value={filters.dateTo}
                onChange={(e) => updateFilters({ dateTo: e.target.value })}
                className="h-10"
              />
            </div>
            <Select
              value={filters.salespersonId || 'all'}
              onValueChange={(value) => updateFilters({ salespersonId: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Salesperson" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Salespeople</SelectItem>
                {salespeople.map((sp) => (
                  <SelectItem key={sp.id} value={sp.id}>
                    {sp.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.status || 'all'}
              onValueChange={(value) => updateFilters({ status: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <Card className="bg-muted/50">
          <CardContent className="py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => setBulkPayDialogOpen(true)}
                >
                  <Banknote className="h-4 w-4 mr-2" />
                  Mark as Paid
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear Selection
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commissions Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Commissions ({filteredCommissions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filteredCommissions.length === 0 ? (
            <div className="text-center py-12">
              <DollarSign className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">
                {hasActiveFilters
                  ? 'No commissions found matching your filters'
                  : 'No commissions recorded yet'}
              </p>
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">
                      <Checkbox
                        checked={selectedIds.size === filteredCommissions.length && filteredCommissions.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead>Order #</TableHead>
                    <TableHead>Commission Date</TableHead>
                    <TableHead>Salesperson</TableHead>
                    <TableHead className="text-right">Order Total</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[80px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCommissions.map((commission) => (
                    <TableRow key={commission.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(commission.id)}
                          onCheckedChange={() => toggleSelect(commission.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        {commission.order?.order_number ? (
                          <button
                            onClick={() => fetchOrderDetail(commission)}
                            className="flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            #{commission.order.order_number}
                          </button>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {format(parseLocalDate(commission.order_date), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>{commission.salesperson?.full_name || '—'}</TableCell>
                      <TableCell className="text-right">
                        ${commission.order_total.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        {commission.rate_applied}%
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ${commission.commission_amount.toFixed(2)}
                      </TableCell>
                      <TableCell>{getStatusBadge(commission.status as CommissionStatus)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {commission.status === 'pending' && (
                              <DropdownMenuItem onClick={() => openActionSheet(commission, 'approve')}>
                                <CheckCircle className="h-4 w-4 mr-2" />
                                Mark as Approved
                              </DropdownMenuItem>
                            )}
                            {(commission.status === 'pending' || commission.status === 'approved') && (
                              <DropdownMenuItem onClick={() => openActionSheet(commission, 'pay')}>
                                <Banknote className="h-4 w-4 mr-2" />
                                Mark as Paid
                              </DropdownMenuItem>
                            )}
                            {commission.status === 'paid' && (
                              <DropdownMenuItem onClick={() => handleRevertClick(commission, 'approved')}>
                                <RotateCcw className="h-4 w-4 mr-2" />
                                Revert to Approved
                              </DropdownMenuItem>
                            )}
                            {(commission.status === 'paid' || commission.status === 'approved') && (
                              <DropdownMenuItem
                                onClick={() => handleRevertClick(commission, 'pending')}
                                className="text-destructive focus:text-destructive"
                              >
                                <RotateCcw className="h-4 w-4 mr-2" />
                                Revert to Pending
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => openActionSheet(commission, 'note')}>
                              <FileText className="h-4 w-4 mr-2" />
                              {commission.notes ? 'Edit Note' : 'Add Note'}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Order Detail Sheet */}
      <Sheet open={orderDetailOpen} onOpenChange={setOrderDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {selectedCommission?.order?.order_number
                ? `Order #${selectedCommission.order.order_number}`
                : 'Order Details'}
              {orderDetail?.order?.status && (
                <Badge variant="outline" className="ml-2 capitalize">
                  {orderDetail.order.status}
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription>
              Commission breakdown by line item
            </SheetDescription>
          </SheetHeader>

          {orderDetailLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : orderDetail?.order ? (
            <div className="space-y-6 pt-6">
              {/* Order Info */}
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="font-medium">{orderDetail.order.customer?.business_name || '—'}</span>
                </div>
                {orderDetail.order.customer?.city && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">City</span>
                    <span>{orderDetail.order.customer.city}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order Date</span>
                  <span>{orderDetail.order.order_date ? format(parseLocalDate(orderDetail.order.order_date), 'MMM d, yyyy') : '—'}</span>
                </div>
                {orderDetail.order.delivery_date && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Delivery Date</span>
                    <span>{format(parseLocalDate(orderDetail.order.delivery_date), 'MMM d, yyyy')}</span>
                  </div>
                )}
                {orderDetail.order.notes && (
                  <div className="pt-1">
                    <span className="text-muted-foreground">Notes</span>
                    <p className="mt-1 text-sm">{orderDetail.order.notes}</p>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Salesperson</span>
                  <span>{selectedCommission?.salesperson?.full_name || '—'}</span>
                </div>
              </div>

              {/* Line Items - Desktop Table */}
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Cases</TableHead>
                      <TableHead className="text-right">Unit Price</TableHead>
                      <TableHead className="text-right">Line Total</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderDetail.breakdown?.map((item) => (
                      <TableRow key={item.order_item_id}>
                        <TableCell className="font-medium text-xs">{item.sku_name || item.sku_code}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">${Number(item.unit_price).toFixed(2)}</TableCell>
                        <TableCell className="text-right">${Number(item.line_total).toFixed(2)}</TableCell>
                        <TableCell className="text-right">{Number(item.commission_rate).toFixed(1)}%</TableCell>
                        <TableCell className="text-right font-medium">${Number(item.commission_amount).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={3} className="font-semibold">Total</TableCell>
                      <TableCell className="text-right font-semibold">
                        ${selectedCommission?.order_total?.toFixed(2) || '0.00'}
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-right font-semibold">
                        ${selectedCommission?.commission_amount?.toFixed(2) || '0.00'}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>

              {/* Line Items - Mobile Cards */}
              <div className="sm:hidden space-y-3">
                {orderDetail.breakdown?.map((item) => (
                  <Card key={item.order_item_id}>
                    <CardContent className="p-3 space-y-1">
                      <p className="font-medium text-sm">{item.sku_name || item.sku_code}</p>
                      <div className="grid grid-cols-2 gap-x-4 text-xs text-muted-foreground">
                        <span>Cases: {item.quantity}</span>
                        <span className="text-right">Unit: ${Number(item.unit_price).toFixed(2)}</span>
                        <span>Line Total: ${Number(item.line_total).toFixed(2)}</span>
                        <span className="text-right">Rate: {Number(item.commission_rate).toFixed(1)}%</span>
                      </div>
                      <p className="text-sm font-medium text-right">Commission: ${Number(item.commission_amount).toFixed(2)}</p>
                    </CardContent>
                  </Card>
                ))}
                <div className="flex justify-between pt-2 border-t font-semibold text-sm px-1">
                  <span>Total: ${selectedCommission?.order_total?.toFixed(2) || '0.00'}</span>
                  <span>Commission: ${selectedCommission?.commission_amount?.toFixed(2) || '0.00'}</span>
                </div>
              </div>

              {/* Edit Order Button */}
              <div className="pt-2">
                <Button variant="outline" asChild className="w-full sm:w-auto">
                  <Link href="/dashboard/orders">
                    <Edit2 className="h-4 w-4 mr-2" />
                    Edit Order
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              Failed to load order details
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Action Sheet */}
      <Sheet open={actionSheetOpen} onOpenChange={setActionSheetOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>
              {actionType === 'approve' && 'Approve Commission'}
              {actionType === 'pay' && 'Mark as Paid'}
              {actionType === 'note' && (actionCommission?.notes ? 'Edit Note' : 'Add Note')}
            </SheetTitle>
            <SheetDescription>
              {actionCommission && (
                <>
                  Order #{actionCommission.order?.order_number} - {actionCommission.salesperson?.full_name}
                  <br />
                  Commission: ${actionCommission.commission_amount.toFixed(2)}
                </>
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 pt-6">
            {actionType === 'approve' && (
              <>
                <p className="text-sm text-muted-foreground">
                  Are you sure you want to approve this commission? This will mark it as ready for payment.
                </p>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={handleApprove} disabled={saving}>
                    {saving ? 'Approving...' : 'Approve'}
                  </Button>
                  <Button variant="outline" onClick={() => setActionSheetOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </>
            )}

            {actionType === 'pay' && (
              <>
                <div className="space-y-2">
                  <Label>Payment Date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          'w-full justify-start text-left font-normal',
                          !paidDate && 'text-muted-foreground'
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {paidDate ? format(paidDate, 'PPP') : 'Pick a date'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={paidDate}
                        onSelect={setPaidDate}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={handleMarkPaid} disabled={saving || !paidDate}>
                    {saving ? 'Saving...' : 'Mark as Paid'}
                  </Button>
                  <Button variant="outline" onClick={() => setActionSheetOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </>
            )}

            {actionType === 'note' && (
              <>
                <div className="space-y-2">
                  <Label>Note</Label>
                  <Textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Add a note about this commission..."
                    rows={4}
                  />
                </div>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={handleSaveNote} disabled={saving}>
                    {saving ? 'Saving...' : 'Save Note'}
                  </Button>
                  <Button variant="outline" onClick={() => setActionSheetOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Bulk Pay Dialog */}
      <AlertDialog open={bulkPayDialogOpen} onOpenChange={setBulkPayDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Commissions as Paid</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to mark {selectedIds.size} commissions as paid. Select the payment date below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label className="mb-2 block">Payment Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start text-left font-normal',
                    !bulkPaidDate && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {bulkPaidDate ? format(bulkPaidDate, 'PPP') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={bulkPaidDate}
                  onSelect={setBulkPaidDate}
                />
              </PopoverContent>
            </Popover>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkPay}
              disabled={bulkSaving || !bulkPaidDate}
            >
              {bulkSaving ? 'Saving...' : 'Mark as Paid'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revert Paid Commission Confirmation */}
      <AlertDialog open={revertDialogOpen} onOpenChange={(open) => { if (!reverting) setRevertDialogOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert Paid Commission?</AlertDialogTitle>
            <AlertDialogDescription>
              {revertCommission && (
                <>
                  Order #{revertCommission.order?.order_number} — ${revertCommission.commission_amount.toFixed(2)} for{' '}
                  {revertCommission.salesperson?.full_name} is currently marked as paid
                  {revertCommission.paid_at && ` (${format(parseLocalDate(revertCommission.paid_at), 'MMM d, yyyy')})`}.
                  {' '}Reverting to &quot;{revertTarget === 'pending' ? 'Pending' : 'Approved'}&quot; will clear the payment
                  date and payer. This cannot be undone automatically — you&apos;ll need to re-mark it as paid later if
                  needed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRevert}
              disabled={reverting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {reverting ? 'Reverting...' : `Revert to ${revertTarget === 'pending' ? 'Pending' : 'Approved'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
