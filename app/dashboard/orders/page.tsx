'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth, canApproveOrder, canEditOrder, canDeleteOrder } from '@/lib/auth-context'
import {
  getOrders,
  getOrderSkus,
  getOrderCommissions,
  getOrder,
  updateOrderStatus,
  saveOrder,
  deleteOrder,
  markTermsOrderPaid,
} from '@/actions/orders'
import type { OrderSkuRecord, CommissionRecord } from '@/actions/orders'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { Plus, Search, ShoppingCart, Calendar, DollarSign, Package, Truck, Edit2, Save, X, Trash2, LayoutGrid, List, ArrowUpDown, ChevronUp, ChevronDown, MoreVertical, Banknote } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { format, parseISO } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import { StatusBadgeDropdown } from '@/components/orders/status-badge-dropdown'
import { ErrorState } from '@/components/ui/error-state'
import type { Order, OrderStatus } from '@/types/database'

// Use server-action types for data fetched via actions
type SKU = OrderSkuRecord

interface EditOrderItem {
  id?: string // undefined for new items
  sku_id: string
  sku_code: string
  sku_name: string
  cases: number // number of cases ordered
  units_per_case: number // units per case for this SKU
  quantity: number // total units (cases * units_per_case)
  unit_price: number // price per unit
  line_total: number // total price (quantity * unit_price)
  _deleted?: boolean // mark for deletion
}

interface EditFormData {
  status: OrderStatus
  order_notes: string
  order_date: string
  requested_delivery_date: string
  delivered_at_override: string
  order_items: EditOrderItem[]
  payment_terms: boolean
  terms_payment_date: string
  terms_paid_at_display: string  // read-only display of actual payment receipt date
}

type SortField = 'order_number' | 'customer' | 'status' | 'order_date' | 'delivery_date' | 'total'
type SortDirection = 'asc' | 'desc'
type ViewMode = 'card' | 'table'

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([])
  const [skus, setSkus] = useState<SKU[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterDeliveryFrom, setFilterDeliveryFrom] = useState('')
  const [filterDeliveryTo, setFilterDeliveryTo] = useState('')
  const [editingOrder, setEditingOrder] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditFormData>({} as EditFormData)
  const [saving, setSaving] = useState(false)
  const [deleteOrderId, setDeleteOrderId] = useState<string | null>(null)
  const [deleteOrderNumber, setDeleteOrderNumber] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('card')
  const [sortField, setSortField] = useState<SortField>('delivery_date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [userSortOverride, setUserSortOverride] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetEditMode, setSheetEditMode] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [commissions, setCommissions] = useState<CommissionRecord[]>([])
  const [markPaidOrderId, setMarkPaidOrderId] = useState<string | null>(null)
  const [markPaidDate, setMarkPaidDate] = useState<string>('')
  const [markingPaid, setMarkingPaid] = useState(false)
  const { user, handleSessionError } = useAuth()

  // Get user role from auth context
  const userRole = user?.role || 'standard'

  useEffect(() => {
    fetchOrders()
    fetchSKUs()
    fetchCommissions()
    // Load saved view preference
    const savedView = localStorage.getItem('ordersViewMode') as ViewMode
    if (savedView === 'card' || savedView === 'table') {
      setViewMode(savedView)
    }
  }, [])

  useEffect(() => {
    filterAndSortOrders()
  }, [orders, searchTerm, filterStatus, filterDeliveryFrom, filterDeliveryTo, sortField, sortDirection, userSortOverride])

  const fetchSKUs = async () => {
    const result = await getOrderSkus()
    if (result.error) {
      console.error('Error fetching SKUs:', result.error)
      if (handleSessionError(result.error)) return
      toast.error("Couldn't load SKUs. Try again.")
      setSkus([])
      return
    }
    setSkus(result.data!)
  }

  const fetchOrders = async () => {
    setError(null)
    const result = await getOrders()
    if (result.error) {
      console.error('Error fetching orders:', result.error)
      if (handleSessionError(result.error)) return
      setError("Couldn't load orders. Try again.")
      setOrders([])
      setLoading(false)
      return
    }
    // getOrders already adds the dispensary alias
    setOrders(result.data as unknown as Order[])
    setLoading(false)
  }

  const fetchCommissions = async () => {
    const result = await getOrderCommissions()
    if (result.error) {
      console.error('Error fetching commissions:', result.error)
      if (handleSessionError(result.error)) return
      toast.error("Couldn't load commissions. Try again.")
      setCommissions([])
      return
    }
    setCommissions(result.data!)
  }

  const filterAndSortOrders = () => {
    let filtered = [...orders]

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(order =>
        order.customer?.business_name?.toLowerCase().includes(term) ||
        order.customer?.license_name?.toLowerCase().includes(term) ||
        order.customer?.omma_license?.toLowerCase().includes(term) ||
        order.customer?.city?.toLowerCase().includes(term) ||
        order.order_number?.toLowerCase().includes(term) ||
        order.order_notes?.toLowerCase().includes(term)
      )
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter(order => order.status === filterStatus)
    }

    // Filter by delivery date range
    if (filterDeliveryFrom) {
      const fromDate = parseLocalDate(filterDeliveryFrom)
      filtered = filtered.filter(order => {
        if (!order.requested_delivery_date) return false
        const deliveryDate = parseLocalDate(order.requested_delivery_date)
        return deliveryDate >= fromDate
      })
    }

    if (filterDeliveryTo) {
      const toDate = new Date(filterDeliveryTo + 'T23:59:59')
      filtered = filtered.filter(order => {
        if (!order.requested_delivery_date) return false
        const deliveryDate = parseLocalDate(order.requested_delivery_date)
        return deliveryDate <= toDate
      })
    }

    // Status priority weights — pending (upcoming) first
    const STATUS_WEIGHT: Record<string, number> = {
      pending: 0,
      confirmed: 1,
      packed: 2,
      delivered: 3,
      cancelled: 4,
    }

    // Sort
    filtered.sort((a, b) => {
      // On default sort (no user override), group by status priority first
      if (!userSortOverride) {
        const aWeight = STATUS_WEIGHT[a.status] ?? 99
        const bWeight = STATUS_WEIGHT[b.status] ?? 99
        if (aWeight !== bWeight) return aWeight - bWeight
      }

      let aVal: string | number | null = null
      let bVal: string | number | null = null

      switch (sortField) {
        case 'order_number':
          aVal = a.order_number || ''
          bVal = b.order_number || ''
          break
        case 'customer':
          aVal = a.customer?.business_name?.toLowerCase() || ''
          bVal = b.customer?.business_name?.toLowerCase() || ''
          break
        case 'status':
          aVal = STATUS_WEIGHT[a.status] ?? 99
          bVal = STATUS_WEIGHT[b.status] ?? 99
          break
        case 'order_date':
          aVal = a.order_date ? parseLocalDate(a.order_date).getTime() : 0
          bVal = b.order_date ? parseLocalDate(b.order_date).getTime() : 0
          break
        case 'delivery_date':
          aVal = a.requested_delivery_date ? parseLocalDate(a.requested_delivery_date).getTime() : 0
          bVal = b.requested_delivery_date ? parseLocalDate(b.requested_delivery_date).getTime() : 0
          break
        case 'total':
          aVal = a.total_price || 0
          bVal = b.total_price || 0
          break
      }

      if (aVal === null || bVal === null) return 0
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1
      return 0
    })

    setFilteredOrders(filtered)
  }

  const toggleSort = (field: SortField) => {
    setUserSortOverride(true)
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4 ml-1 opacity-50" />
    return sortDirection === 'asc'
      ? <ChevronUp className="h-4 w-4 ml-1" />
      : <ChevronDown className="h-4 w-4 ml-1" />
  }

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode)
    localStorage.setItem('ordersViewMode', mode)
  }

  const handleRowClick = (order: Order) => {
    setSelectedOrder(order)
    setSheetEditMode(false)
    setSheetOpen(true)
  }

  const toggleCardExpanded = (orderId: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline">Pending</Badge>
      case 'confirmed':
        return <Badge variant="default">Confirmed</Badge>
      case 'packed':
        return <Badge variant="default" className="bg-blue-600">Packed</Badge>
      case 'delivered':
        return <Badge variant="default" className="bg-green-600">Delivered</Badge>
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>
      default:
        return null
    }
  }

  const canApproveOrders = canApproveOrder(userRole)
  const canEditOrders = canEditOrder(userRole)
  const canDeleteOrders = canDeleteOrder(userRole)

  const quickUpdateStatus = async (orderId: string, newStatus: string) => {
    if (!canApproveOrders || !user) return

    const result = await updateOrderStatus(orderId, newStatus)
    if (result.error) {
      console.error('Error updating order status:', result.error)
      toast.error('Failed to update order status')
      return
    }

    toast.success(`Order status updated to ${newStatus}`)
    fetchOrders()

    if (selectedOrder?.id === orderId) {
      setSelectedOrder({ ...selectedOrder, status: newStatus as OrderStatus })
    }
  }

  const confirmOrder = async (orderId: string) => {
    if (!canApproveOrders || !user) return

    const result = await updateOrderStatus(orderId, 'confirmed')
    if (result.error) {
      console.error('Error confirming order:', result.error)
      return
    }
    fetchOrders()
  }

  const startEditing = (order: Order) => {
    setEditingOrder(order.id)

    // Convert order items to edit format
    // Database stores CASES in quantity field, not units
    const editItems: EditOrderItem[] = (order.order_items || []).map(item => {
      // Find the SKU to get units_per_case
      const sku = skus.find(s => s.id === item.sku_id)
      const unitsPerCase = sku?.units_per_case || 32 // default to 32 if not found
      const cases = item.quantity // quantity IS cases (not units)
      const totalUnits = cases * unitsPerCase // calculate total units for display

      return {
        id: item.id,
        sku_id: item.sku_id,
        sku_code: item.sku?.code || '',
        sku_name: item.sku?.name || '',
        cases: cases,
        units_per_case: unitsPerCase,
        quantity: totalUnits, // total units for display/pricing calculation
        unit_price: item.unit_price || 0,
        line_total: item.line_total || (totalUnits * (item.unit_price || 0)),
      }
    })

    setEditForm({
      status: order.status,
      order_notes: order.order_notes || '',
      order_date: order.order_date ? order.order_date.split('T')[0] : '',
      requested_delivery_date: order.requested_delivery_date ? order.requested_delivery_date.split('T')[0] : '',
      delivered_at_override: order.delivered_at ? order.delivered_at.split('T')[0] : '',
      order_items: editItems,
      payment_terms: order.payment_terms ?? false,
      terms_payment_date: order.terms_payment_date || '',
      terms_paid_at_display: order.terms_paid_at ? order.terms_paid_at.substring(0, 10) : '',
    })
  }

  const startSheetEditing = (order: Order) => {
    startEditing(order)
    setSheetEditMode(true)
  }

  const cancelSheetEditing = () => {
    setSheetEditMode(false)
    setEditingOrder(null)
    setEditForm({} as EditFormData)
  }

  const saveSheetOrder = async () => {
    if (!selectedOrder || !user) return
    setSaving(true)
    try {
      const result = await saveOrder(selectedOrder.id, {
        status: editForm.status,
        order_notes: editForm.order_notes,
        requested_delivery_date: editForm.requested_delivery_date || null,
        delivered_at_override: editForm.delivered_at_override,
        existing_delivered_at: selectedOrder.delivered_at,
        items: (editForm.order_items ?? []).map(item => ({
          id: item.id,
          sku_id: item.sku_id,
          cases: item.cases,
          unit_price: item.unit_price,
          line_total: item.line_total,
          _deleted: item._deleted,
        })),
        payment_terms: editForm.payment_terms ?? false,
        terms_payment_date: editForm.payment_terms ? (editForm.terms_payment_date || null) : null,
      })

      if (result.error) throw new Error(result.error)

      toast.success('Order saved successfully')
      setSheetEditMode(false)
      setEditingOrder(null)
      setEditForm({} as EditFormData)
      await fetchOrders()

      // Refresh the selected order in the sheet
      const refreshed = await getOrder(selectedOrder.id)
      if (!refreshed.error && refreshed.data) {
        setSelectedOrder(refreshed.data as unknown as Order)
      }
    } catch (error) {
      console.error('Error saving order:', error)
      toast.error('Error saving order. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // Calculate edit form total
  const getEditTotal = () => {
    return editForm.order_items
      ?.filter(item => !item._deleted)
      .reduce((sum, item) => sum + item.line_total, 0) || 0
  }

  // Add new item to edit form
  const addEditItem = () => {
    if (skus.length === 0) return
    const firstSku = skus[0]
    const unitsPerCase = firstSku.units_per_case || 32
    const cases = 1
    const quantity = cases * unitsPerCase
    const unitPrice = firstSku.price_per_unit || 0
    const lineTotal = quantity * unitPrice

    const newItem: EditOrderItem = {
      sku_id: firstSku.id,
      sku_code: firstSku.code,
      sku_name: firstSku.name,
      cases: cases,
      units_per_case: unitsPerCase,
      quantity: quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
    }
    setEditForm(prev => ({
      ...prev,
      order_items: [...(prev.order_items || []), newItem]
    }))
  }

  // Update item in edit form
  const updateEditItem = (index: number, field: keyof EditOrderItem, value: string | number) => {
    setEditForm(prev => {
      const items = [...(prev.order_items || [])]
      items[index] = { ...items[index], [field]: value }

      if (field === 'sku_id') {
        // SKU changed - update all related fields
        const sku = skus.find(s => s.id === value)
        if (sku) {
          items[index].sku_code = sku.code
          items[index].sku_name = sku.name
          items[index].units_per_case = sku.units_per_case || 32
          items[index].unit_price = sku.price_per_unit || 0
          // Recalculate quantity and line_total based on current cases
          items[index].quantity = items[index].cases * items[index].units_per_case
          items[index].line_total = items[index].quantity * items[index].unit_price
        }
      } else if (field === 'cases') {
        // Cases changed - recalculate quantity and line_total
        const cases = value as number
        items[index].quantity = cases * items[index].units_per_case
        items[index].line_total = items[index].quantity * items[index].unit_price
      } else if (field === 'unit_price') {
        // Unit price changed - recalculate line_total
        items[index].line_total = items[index].quantity * (value as number)
      }

      return { ...prev, order_items: items }
    })
  }

  // Remove item from edit form (mark for deletion if existing, or remove if new)
  const removeEditItem = (index: number) => {
    setEditForm(prev => {
      const items = [...(prev.order_items || [])]
      if (items[index].id) {
        // Existing item - mark for deletion
        items[index] = { ...items[index], _deleted: true }
      } else {
        // New item - just remove from array
        items.splice(index, 1)
      }
      return { ...prev, order_items: items }
    })
  }

  const updateEditForm = <K extends keyof EditFormData>(field: K, value: EditFormData[K]) => {
    setEditForm((prev: EditFormData) => ({...prev, [field]: value}))
  }

  const handleMarkPaid = async () => {
    if (!markPaidOrderId || !markPaidDate) return
    setMarkingPaid(true)
    try {
      const result = await markTermsOrderPaid(markPaidOrderId, markPaidDate)
      if (result.error) throw new Error(result.error)

      toast.success('Payment recorded — revenue and commission updated')
      setMarkPaidOrderId(null)
      setMarkPaidDate('')
      await fetchOrders()

      // Refresh selected order in the sheet if it was the one paid
      if (selectedOrder?.id === markPaidOrderId) {
        const refreshed = await getOrder(markPaidOrderId)
        if (!refreshed.error && refreshed.data) {
          setSelectedOrder(refreshed.data as unknown as Order)
        }
      }
    } catch (error) {
      console.error('Error recording payment:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to record payment')
    } finally {
      setMarkingPaid(false)
    }
  }

  const handleDeleteOrder = async () => {
    if (!deleteOrderId) return
    setDeleting(true)
    try {
      const result = await deleteOrder(deleteOrderId)
      if (result.error) throw new Error(result.error)

      toast.success('Order deleted successfully')
      setDeleteOrderId(null)
      setDeleteOrderNumber(null)
      fetchOrders()
    } catch (error) {
      console.error('Error deleting order:', error)
      toast.error('Failed to delete order. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading orders...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Orders</h1>
          <p className="text-muted-foreground mt-1">Manage wholesale orders and deliveries</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border rounded-lg p-1">
            <Button
              variant={viewMode === 'card' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => handleViewModeChange('card')}
              className="px-2"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => handleViewModeChange('table')}
              className="px-2"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button asChild>
            <Link href="/dashboard/orders/new">
              <Plus className="mr-2 h-4 w-4" />
              New Order
            </Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Filters</CardTitle>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {filteredOrders.length} of {orders.length} orders
              </span>
              {(searchTerm || filterStatus !== 'all' || filterDeliveryFrom || filterDeliveryTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchTerm('')
                    setFilterStatus('all')
                    setFilterDeliveryFrom('')
                    setFilterDeliveryTo('')
                  }}
                >
                  Clear Filters
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search orders..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="packed">Packed</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={filterDeliveryFrom}
              onChange={(e) => setFilterDeliveryFrom(e.target.value)}
              placeholder="Delivery from"
            />
            <Input
              type="date"
              value={filterDeliveryTo}
              onChange={(e) => setFilterDeliveryTo(e.target.value)}
              placeholder="Delivery to"
            />
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      {(() => {
        const summaryOrderCount = filteredOrders.length
        const summaryRevenue = filteredOrders.reduce((sum, o) => sum + (o.total_price || 0), 0)
        const summaryCommissions = filteredOrders.reduce((sum, o) => {
          const commission = commissions.find(c => c.order_id === o.id)
          return sum + (commission?.commission_amount || 0)
        }, 0)

        return (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <Package className="h-4 w-4" />
                  Orders
                </div>
                <div className="text-2xl font-bold">{summaryOrderCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <DollarSign className="h-4 w-4" />
                  Revenue
                </div>
                <div className="text-2xl font-bold">${summaryRevenue.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <Banknote className="h-4 w-4" />
                  Commissions
                </div>
                <div className="text-2xl font-bold">${summaryCommissions.toFixed(2)}</div>
              </CardContent>
            </Card>
          </div>
        )
      })()}

      {/* Orders List */}
      {error ? (
        <ErrorState title="Unable to load orders" message={error} onRetry={fetchOrders} />
      ) : filteredOrders.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ShoppingCart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">
              {searchTerm || filterStatus !== 'all' || filterDeliveryFrom || filterDeliveryTo
                ? 'No orders found matching your filters'
                : 'No orders created yet'}
            </p>
            <Button asChild>
              <Link href="/dashboard/orders/new">
                <Plus className="mr-2 h-4 w-4" />
                Create Your First Order
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : viewMode === 'table' ? (
        /* Table View */
        <Card className="overflow-hidden">
          <CardContent className="p-0 min-w-0">
            <div className="overflow-auto">
              <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden sm:table-cell">
                  <button
                    className="flex items-center font-medium hover:text-foreground"
                    onClick={() => toggleSort('order_number')}
                  >
                    Order #
                    <SortIcon field="order_number" />
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    className="flex items-center font-medium hover:text-foreground"
                    onClick={() => toggleSort('customer')}
                  >
                    Customer
                    <SortIcon field="customer" />
                  </button>
                </TableHead>
                <TableHead className="hidden md:table-cell">Items</TableHead>
                <TableHead>
                  <button
                    className="flex items-center font-medium hover:text-foreground"
                    onClick={() => toggleSort('status')}
                  >
                    Status
                    <SortIcon field="status" />
                  </button>
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  <button
                    className="flex items-center font-medium hover:text-foreground"
                    onClick={() => toggleSort('order_date')}
                  >
                    Created
                    <SortIcon field="order_date" />
                  </button>
                </TableHead>
                <TableHead className="hidden sm:table-cell">
                  <button
                    className="flex items-center font-medium hover:text-foreground"
                    onClick={() => toggleSort('delivery_date')}
                  >
                    Delivery
                    <SortIcon field="delivery_date" />
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button
                    className="flex items-center font-medium hover:text-foreground ml-auto"
                    onClick={() => toggleSort('total')}
                  >
                    Total
                    <SortIcon field="total" />
                  </button>
                </TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.map((order) => (
                <TableRow
                  key={order.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => handleRowClick(order)}
                >
                  <TableCell className="hidden sm:table-cell font-medium">
                    {order.order_number ? `#${order.order_number}` : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{order.customer?.business_name || 'Unknown'}</div>
                    {/* Mobile: order number + delivery date as sub-text */}
                    <div className="sm:hidden text-xs text-muted-foreground mt-0.5 space-y-0.5">
                      {order.order_number && <span className="block">#{order.order_number}</span>}
                      {order.requested_delivery_date && (
                        <span className="block flex items-center gap-1">
                          <Truck className="h-3 w-3 inline" />
                          {' '}{format(parseLocalDate(order.requested_delivery_date), 'MMM d, yyyy')}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span className="text-muted-foreground">
                      {order.order_items?.length || 0} items
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadgeDropdown orderId={order.id} currentStatus={order.status} canChangeStatus={canApproveOrders} onStatusChange={quickUpdateStatus} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {format(parseLocalDate(order.order_date), 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {order.requested_delivery_date
                      ? format(parseLocalDate(order.requested_delivery_date), 'MMM d, yyyy')
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    ${(order.total_price || 0).toFixed(2)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {(canEditOrders || canDeleteOrders) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canEditOrders && (
                            <DropdownMenuItem onClick={() => {
                              setSelectedOrder(order)
                              startSheetEditing(order)
                              setSheetOpen(true)
                            }}>
                              <Edit2 className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          {canDeleteOrders && (
                            <DropdownMenuItem
                              onClick={() => {
                                setDeleteOrderId(order.id)
                                setDeleteOrderNumber(order.order_number || order.id.slice(0, 8))
                              }}
                              className="text-red-600 focus:text-red-600"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* Card View */
        <div className="space-y-4">
          {filteredOrders.map((order) => (
            <Card
              key={order.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => toggleCardExpanded(order.id)}
            >
              <CardContent className="p-4 md:p-6">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  {/* Left side: Customer name, order number, delivery date */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-lg">
                          {order.customer?.business_name || 'Unknown Customer'}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                          {order.order_number && (
                            <span className="font-medium">#{order.order_number}</span>
                          )}
                          {order.requested_delivery_date && (
                            <div className="flex items-center gap-1">
                              <Truck className="h-4 w-4" />
                              {format(parseLocalDate(order.requested_delivery_date), 'MMM d, yyyy')}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Mobile: 3-dot menu in top right */}
                      <div className="md:hidden">
                        {(canApproveOrders || canEditOrders || canDeleteOrders) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {order.status === 'pending' && canApproveOrders && (
                                <DropdownMenuItem onClick={(e) => {
                                  e.stopPropagation()
                                  confirmOrder(order.id)
                                }}>
                                  Confirm Order
                                </DropdownMenuItem>
                              )}
                              {canEditOrders && (
                                <DropdownMenuItem onClick={(e) => {
                                  e.stopPropagation()
                                  setSelectedOrder(order)
                                  startSheetEditing(order)
                                  setSheetOpen(true)
                                }}>
                                  <Edit2 className="h-4 w-4 mr-2" />
                                  Edit Order
                                </DropdownMenuItem>
                              )}
                              {canDeleteOrders && (
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDeleteOrderId(order.id)
                                    setDeleteOrderNumber(order.order_number || order.id.slice(0, 8))
                                  }}
                                  className="text-red-600 focus:text-red-600"
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-sm">
                      <StatusBadgeDropdown orderId={order.id} currentStatus={order.status} canChangeStatus={canApproveOrders} onStatusChange={quickUpdateStatus} />
                      <div className="font-semibold flex items-center">
                        <DollarSign className="h-4 w-4" />
                        {(order.total_price || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {/* Desktop: Right side actions */}
                  <div className="hidden md:flex items-center gap-3">
                    {(canApproveOrders || canEditOrders || canDeleteOrders) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {order.status === 'pending' && canApproveOrders && (
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation()
                              confirmOrder(order.id)
                            }}>
                              Confirm Order
                            </DropdownMenuItem>
                          )}
                          {canEditOrders && (
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation()
                              setSelectedOrder(order)
                              startSheetEditing(order)
                              setSheetOpen(true)
                            }}>
                              <Edit2 className="h-4 w-4 mr-2" />
                              Edit Order
                            </DropdownMenuItem>
                          )}
                          {canDeleteOrders && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                setDeleteOrderId(order.id)
                                setDeleteOrderNumber(order.order_number || order.id.slice(0, 8))
                              }}
                              className="text-red-600 focus:text-red-600"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </CardContent>

              {/* Collapsible Content */}
              {expandedCards.has(order.id) && (
                <div className="px-4 pb-4 md:px-6 md:pb-6 pt-0 space-y-3">
                  {/* Order Items */}
                  {order.order_items && order.order_items.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium flex items-center gap-1">
                        <Package className="h-4 w-4" />
                        Order Items:
                      </div>
                      <div className="pl-5 space-y-1">
                        {order.order_items.map((item) => {
                          const cases = item.quantity
                          return (
                            <div key={item.id} className="text-sm text-muted-foreground flex justify-between">
                              <span>{item.sku?.code || 'Unknown'} × {cases} {cases === 1 ? 'case' : 'cases'}</span>
                              <span>${(item.line_total || 0).toFixed(2)}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Delivered Date - only show if order was delivered */}
                  {order.delivered_at && (
                    <div className="flex flex-wrap gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        <Truck className="h-4 w-4 text-green-600" />
                        <span className="text-green-600">
                          Delivered: {format(parseISO(order.delivered_at), 'MMM d, yyyy')}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Order Notes */}
                  {order.order_notes && (
                    <p className="text-sm text-muted-foreground">
                      {order.order_notes}
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Order Details Sheet */}
      <Sheet open={sheetOpen} onOpenChange={(open) => {
        setSheetOpen(open)
        if (!open) {
          setSheetEditMode(false)
          setEditingOrder(null)
          setEditForm({} as EditFormData)
        }
      }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2">
              {sheetEditMode ? 'Edit ' : ''}Order {selectedOrder?.order_number ? `#${selectedOrder.order_number}` : ''}
              {selectedOrder && !sheetEditMode && (
                <StatusBadgeDropdown orderId={selectedOrder.id} currentStatus={selectedOrder.status} canChangeStatus={canApproveOrders} onStatusChange={quickUpdateStatus} />
              )}
            </SheetTitle>
          </SheetHeader>

          {selectedOrder && !sheetEditMode && (
            <div className="space-y-6">
              {/* Customer */}
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-1">Customer</h3>
                <p className="text-lg font-semibold">{selectedOrder.customer?.business_name || 'Unknown'}</p>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-1">Order Date</h3>
                  <p className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    {format(parseLocalDate(selectedOrder.order_date), 'MMM d, yyyy')}
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-1">Delivery Date</h3>
                  <p className="flex items-center gap-2">
                    <Truck className="h-4 w-4 text-muted-foreground" />
                    {selectedOrder.requested_delivery_date
                      ? format(parseLocalDate(selectedOrder.requested_delivery_date), 'MMM d, yyyy')
                      : '—'}
                  </p>
                </div>
              </div>

              {/* Delivered At */}
              {selectedOrder.delivered_at && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-1">Delivered</h3>
                  <p className="flex items-center gap-2 text-green-600">
                    <Truck className="h-4 w-4" />
                    {format(parseISO(selectedOrder.delivered_at), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
              )}

              {/* Payment Terms info */}
              {selectedOrder.payment_terms && (
                <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Payment Terms
                  </h3>
                  {selectedOrder.terms_paid_at ? (
                    <p className="text-sm text-green-600">
                      Payment received: {format(parseLocalDate(selectedOrder.terms_paid_at.substring(0, 10)), 'MMM d, yyyy')}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Expected: {selectedOrder.terms_payment_date
                        ? format(parseLocalDate(selectedOrder.terms_payment_date), 'MMM d, yyyy')
                        : '—'}
                    </p>
                  )}
                  {/* Mark Payment Received button — EDIT_ROLES gate, Stokely amendment */}
                  {selectedOrder.payment_terms &&
                    selectedOrder.status === 'delivered' &&
                    !selectedOrder.terms_paid_at &&
                    canEditOrders && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1"
                        onClick={() => {
                          setMarkPaidOrderId(selectedOrder.id)
                          setMarkPaidDate(new Date().toISOString().split('T')[0])
                        }}
                      >
                        <Banknote className="h-4 w-4 mr-2" />
                        Mark Payment Received
                      </Button>
                    )}
                </div>
              )}

              {/* Order Items */}
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Order Items ({selectedOrder.order_items?.length || 0})
                </h3>
                {selectedOrder.order_items && selectedOrder.order_items.length > 0 ? (
                  <div className="border rounded-lg divide-y">
                    {selectedOrder.order_items.map((item) => {
                      // quantity stores cases, not units
                      const sku = skus.find(s => s.id === item.sku_id)
                      const unitsPerCase = sku?.units_per_case || 32
                      const cases = item.quantity
                      const totalUnits = cases * unitsPerCase

                      return (
                        <div key={item.id} className="p-3">
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="font-medium">{item.sku?.code || 'Unknown SKU'}</p>
                              <p className="text-sm text-muted-foreground">{item.sku?.name}</p>
                            </div>
                            <p className="font-semibold">${(item.line_total || 0).toFixed(2)}</p>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            {cases} {cases === 1 ? 'case' : 'cases'} ({totalUnits} units) × ${(item.unit_price || 0).toFixed(2)}/unit
                          </p>
                        </div>
                      )
                    })}
                    <div className="flex justify-between items-center p-3 bg-muted/50">
                      <p className="font-semibold">Total</p>
                      <p className="text-lg font-bold">${(selectedOrder.total_price || 0).toFixed(2)}</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No items</p>
                )}
              </div>

              {/* Order Notes */}
              {selectedOrder.order_notes && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-1">Notes</h3>
                  <p className="text-sm bg-muted/50 rounded-lg p-3">{selectedOrder.order_notes}</p>
                </div>
              )}

              {/* Last Edited */}
              {selectedOrder.last_edited_at && (
                <div className="text-xs text-muted-foreground">
                  Last edited: {format(parseISO(selectedOrder.last_edited_at), 'MMM d, yyyy h:mm a')}
                </div>
              )}

              {/* Actions */}
              {(canEditOrders || canDeleteOrders) && (
                <div className="flex gap-2 pt-4 border-t">
                  {canEditOrders && (
                    <Button
                      className="flex-1"
                      onClick={() => startSheetEditing(selectedOrder)}
                    >
                      <Edit2 className="h-4 w-4 mr-2" />
                      Edit Order
                    </Button>
                  )}
                  {canDeleteOrders && (
                    <Button
                      variant="outline"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => {
                        setSheetOpen(false)
                        setDeleteOrderId(selectedOrder.id)
                        setDeleteOrderNumber(selectedOrder.order_number || selectedOrder.id.slice(0, 8))
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Edit Mode Content */}
          {selectedOrder && sheetEditMode && (
            <div className="space-y-4">
              {/* Customer (read-only in edit mode) */}
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-1">Customer</h3>
                <p className="font-medium">{selectedOrder.customer?.business_name || 'Unknown'}</p>
              </div>

              {/* Order Details */}
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Status</label>
                  <Select
                    value={editForm.status}
                    onValueChange={(value) => updateEditForm('status', value as OrderStatus)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="confirmed">Confirmed</SelectItem>
                      <SelectItem value="packed">Packed</SelectItem>
                      <SelectItem value="delivered">Delivered</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Order Date</label>
                  <p className="text-sm py-2">{editForm.order_date ? format(parseLocalDate(editForm.order_date), 'MMM d, yyyy') : '—'}</p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Requested Delivery Date</label>
                  <Input
                    type="date"
                    value={editForm.requested_delivery_date}
                    onChange={(e) => updateEditForm('requested_delivery_date', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Delivered Date</label>
                  <Input
                    type="date"
                    value={editForm.delivered_at_override}
                    onChange={(e) => updateEditForm('delivered_at_override', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Date order was delivered — controls which month revenue is attributed to.
                  </p>
                </div>

                {/* Payment Terms */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Payment Terms</Label>
                    <Switch
                      checked={editForm.payment_terms ?? false}
                      onCheckedChange={(checked) => {
                        updateEditForm('payment_terms', checked)
                        if (!checked) updateEditForm('terms_payment_date', '')
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Enable if this customer pays after delivery. Revenue defers to payment date.
                  </p>
                </div>

                {editForm.payment_terms && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Payment Expected *</label>
                    <Input
                      type="date"
                      value={editForm.terms_payment_date}
                      onChange={(e) => updateEditForm('terms_payment_date', e.target.value)}
                    />
                  </div>
                )}

                {editForm.payment_terms &&
                  selectedOrder.status === 'delivered' &&
                  !editForm.terms_paid_at_display &&
                  canEditOrders && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full mt-1"
                      onClick={() => {
                        setMarkPaidOrderId(selectedOrder.id)
                        setMarkPaidDate(new Date().toISOString().split('T')[0])
                      }}
                    >
                      <Banknote className="h-4 w-4 mr-2" />
                      Mark Payment Received
                    </Button>
                  )}

                {editForm.terms_paid_at_display && (
                  <div className="text-sm text-green-600 flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Payment received: {format(parseLocalDate(editForm.terms_paid_at_display), 'MMM d, yyyy')}
                  </div>
                )}
              </div>

              {/* Order Items Edit */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium flex items-center gap-1">
                    <Package className="h-4 w-4" />
                    Order Items
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addEditItem}
                    disabled={skus.length === 0}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Item
                  </Button>
                </div>

                {editForm.order_items?.filter(item => !item._deleted).length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-4 border rounded-md">
                    No items. Click "Add Item" to add products.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {editForm.order_items?.map((item, index) => (
                      !item._deleted && (
                        <div key={index} className="p-3 border rounded-md bg-muted/50 space-y-2">
                          {/* SKU Selection */}
                          <div className="flex items-center gap-2">
                            <Select
                              value={item.sku_id}
                              onValueChange={(value) => updateEditItem(index, 'sku_id', value)}
                            >
                              <SelectTrigger className="flex-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {skus.map((sku) => (
                                  <SelectItem key={sku.id} value={sku.id}>
                                    {sku.code} - {sku.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeEditItem(index)}
                              className="h-8 w-8 shrink-0"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                          {/* Cases, Unit Price, Total */}
                          <div className="flex items-center gap-2 text-sm">
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min="1"
                                value={item.cases}
                                onChange={(e) => updateEditItem(index, 'cases', parseInt(e.target.value) || 1)}
                                className="w-16 h-8"
                              />
                              <span className="text-muted-foreground whitespace-nowrap">
                                cases ({item.quantity} units)
                              </span>
                            </div>
                            <span className="text-muted-foreground">×</span>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">$</span>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.unit_price}
                                onChange={(e) => updateEditItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                                className="w-20 h-8"
                              />
                              <span className="text-muted-foreground">/unit</span>
                            </div>
                            <span className="text-muted-foreground">=</span>
                            <span className="font-semibold whitespace-nowrap">
                              ${item.line_total.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )
                    ))}
                  </div>
                )}

                <div className="flex justify-center pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addEditItem}
                    disabled={skus.length === 0}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Item
                  </Button>
                </div>

                {/* Edit Total */}
                <div className="flex justify-end pt-2 border-t">
                  <div className="text-sm font-medium">
                    Total: <span className="text-lg">${getEditTotal().toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Order Notes */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Order Notes</label>
                <Textarea
                  value={editForm.order_notes}
                  onChange={(e) => updateEditForm('order_notes', e.target.value)}
                  placeholder="Order notes..."
                  rows={3}
                />
              </div>

              {/* Save/Cancel Buttons */}
              <div className="flex gap-2 pt-4 border-t">
                <Button
                  className="flex-1"
                  onClick={saveSheetOrder}
                  disabled={saving}
                >
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
                <Button
                  variant="outline"
                  onClick={cancelSheetEditing}
                  disabled={saving}
                >
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Mark Payment Received Dialog */}
      <AlertDialog open={!!markPaidOrderId} onOpenChange={(open) => {
        if (!open) { setMarkPaidOrderId(null); setMarkPaidDate('') }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Payment Received</AlertDialogTitle>
            <AlertDialogDescription>
              Record the date payment was received for this terms order. This realizes revenue and
              fires the commission calculation dated to the payment date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1 pb-2">
            <label className="text-sm font-medium">Payment Date</label>
            <Input
              type="date"
              value={markPaidDate}
              onChange={(e) => setMarkPaidDate(e.target.value)}
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={markingPaid}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMarkPaid}
              disabled={markingPaid || !markPaidDate}
            >
              {markingPaid ? 'Recording...' : 'Confirm Payment'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteOrderId} onOpenChange={(open) => !open && setDeleteOrderId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Order</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete order #{deleteOrderNumber}? This action cannot be undone
              and will remove all order items as well.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOrder}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
