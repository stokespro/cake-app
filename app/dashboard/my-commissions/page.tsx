'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import {
  DollarSign,
  Clock,
  CheckCircle,
  Banknote,
  Calendar,
  Loader2,
} from 'lucide-react'
import { format, startOfMonth, endOfMonth, subMonths, startOfQuarter, startOfYear } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import type { CommissionStatus } from '@/types/database'
import {
  getMyCommissions,
  getMyOrderDetail,
  type CommissionRow,
  type OrderDetail,
  type CommissionBreakdownItem,
} from '@/actions/commissions'

type PeriodType = 'this-month' | 'last-month' | 'this-quarter' | 'this-year' | 'all-time' | 'custom'

interface FilterState {
  dateFrom: string
  dateTo: string
  status: string
  period: PeriodType
}

const initialFilters: FilterState = {
  dateFrom: '',
  dateTo: '',
  status: 'all',
  period: 'all-time',
}

export default function MyCommissionsPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  const [commissions, setCommissions] = useState<CommissionRow[]>([])
  const [filteredCommissions, setFilteredCommissions] = useState<CommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<FilterState>(initialFilters)

  // Order detail sheet state
  const [selectedCommission, setSelectedCommission] = useState<CommissionRow | null>(null)
  const [orderDetailOpen, setOrderDetailOpen] = useState(false)
  const [orderDetail, setOrderDetail] = useState<{ order: OrderDetail; breakdown: CommissionBreakdownItem[] } | null>(null)
  const [orderDetailLoading, setOrderDetailLoading] = useState(false)

  const userRole = user?.role || 'standard'
  const canAccess = ['sales', 'agent', 'management', 'admin'].includes(userRole)

  useEffect(() => {
    if (!authLoading && user && !canAccess) {
      router.push('/dashboard')
    }
  }, [user, authLoading, canAccess, router])

  useEffect(() => {
    if (canAccess && user) {
      fetchData()
    }
  }, [canAccess, user])

  useEffect(() => {
    filterCommissions()
  }, [commissions, filters])

  const fetchData = async () => {
    try {
      const result = await getMyCommissions()
      if (result.error) throw new Error(result.error)
      setCommissions(result.data ?? [])
    } catch (error) {
      console.error('Error fetching commissions:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchOrderDetail = async (commission: CommissionRow) => {
    setSelectedCommission(commission)
    setOrderDetailOpen(true)
    setOrderDetailLoading(true)
    try {
      const result = await getMyOrderDetail(commission.order_id, commission.id)
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
      const fromDate = parseLocalDate(filters.dateFrom)
      filtered = filtered.filter(c => parseLocalDate(c.order_date) >= fromDate)
    }
    if (filters.dateTo) {
      const toDate = new Date(filters.dateTo + 'T23:59:59')
      filtered = filtered.filter(c => parseLocalDate(c.order_date) <= toDate)
    }

    // Filter by status
    if (filters.status && filters.status !== 'all') {
      filtered = filtered.filter(c => c.status === filters.status)
    }

    setFilteredCommissions(filtered)
  }, [commissions, filters])

  const handlePeriodChange = (period: PeriodType) => {
    const now = new Date()
    let dateFrom = ''
    let dateTo = ''

    switch (period) {
      case 'this-month':
        dateFrom = format(startOfMonth(now), 'yyyy-MM-dd')
        dateTo = format(endOfMonth(now), 'yyyy-MM-dd')
        break
      case 'last-month':
        const lastMonth = subMonths(now, 1)
        dateFrom = format(startOfMonth(lastMonth), 'yyyy-MM-dd')
        dateTo = format(endOfMonth(lastMonth), 'yyyy-MM-dd')
        break
      case 'this-quarter':
        dateFrom = format(startOfQuarter(now), 'yyyy-MM-dd')
        dateTo = format(now, 'yyyy-MM-dd')
        break
      case 'this-year':
        dateFrom = format(startOfYear(now), 'yyyy-MM-dd')
        dateTo = format(now, 'yyyy-MM-dd')
        break
      case 'all-time':
        dateFrom = ''
        dateTo = ''
        break
      case 'custom':
        // Keep existing dates for custom
        return setFilters(prev => ({ ...prev, period }))
    }

    setFilters(prev => ({ ...prev, period, dateFrom, dateTo }))
  }


  // Summary calculations - based on filtered results
  const filteredTotal = filteredCommissions.reduce((sum, c) => sum + c.commission_amount, 0)

  const totalPending = filteredCommissions
    .filter(c => c.status === 'pending')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  const totalApproved = filteredCommissions
    .filter(c => c.status === 'approved')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  const totalPaid = filteredCommissions
    .filter(c => c.status === 'paid')
    .reduce((sum, c) => sum + c.commission_amount, 0)

  // Filtered totals for table footer
  const filteredOrderTotal = filteredCommissions.reduce((sum, c) => sum + c.order_total, 0)
  const filteredCommissionTotal = filteredCommissions.reduce((sum, c) => sum + c.commission_amount, 0)

  const getStatusBadge = (status: CommissionStatus) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
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

  if (!canAccess) {
    return null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">My Commissions</h1>
        <p className="text-muted-foreground mt-1">Track your sales commissions and earnings</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">${filteredTotal.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-yellow-600">${totalPending.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Approved
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
              Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">${totalPaid.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Period Selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filter Period</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={filters.period === 'this-month' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handlePeriodChange('this-month')}
              >
                This Month
              </Button>
              <Button
                variant={filters.period === 'last-month' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handlePeriodChange('last-month')}
              >
                Last Month
              </Button>
              <Button
                variant={filters.period === 'this-quarter' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handlePeriodChange('this-quarter')}
              >
                This Quarter
              </Button>
              <Button
                variant={filters.period === 'this-year' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handlePeriodChange('this-year')}
              >
                This Year
              </Button>
              <Button
                variant={filters.period === 'all-time' ? 'default' : 'outline'}
                size="sm"
                onClick={() => handlePeriodChange('all-time')}
              >
                All Time
              </Button>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center w-full">
              <Input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters(prev => ({
                  ...prev,
                  period: 'custom',
                  dateFrom: e.target.value,
                }))}
                className="h-9 w-full sm:w-[140px]"
              />
              <span className="text-sm text-muted-foreground hidden sm:inline">to</span>
              <Input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters(prev => ({
                  ...prev,
                  period: 'custom',
                  dateTo: e.target.value,
                }))}
                className="h-9 w-full sm:w-[140px]"
              />
              <Select
                value={filters.status}
                onValueChange={(value) => setFilters(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger className="w-full sm:w-[140px]">
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
          </div>
        </CardContent>
      </Card>

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
                No commissions found for the selected period
              </p>
            </div>
          ) : (
            <>
              {/* Mobile Card View */}
              <div className="sm:hidden space-y-3 p-4">
                {filteredCommissions.map((commission) => (
                  <Card key={commission.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => fetchOrderDetail(commission)}
                        className="font-medium hover:underline cursor-pointer"
                      >
                        #{commission.order?.order_number || '—'}
                      </button>
                      {getStatusBadge(commission.status as CommissionStatus)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {commission.order?.customer?.business_name || '—'}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {format(parseLocalDate(commission.order_date), 'MMM d, yyyy')}
                      </span>
                      <span className="text-muted-foreground">{commission.rate_applied}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        ${commission.order_total.toFixed(2)}
                      </span>
                      <span className="font-semibold text-green-600">
                        ${commission.commission_amount.toFixed(2)}
                      </span>
                    </div>
                  </Card>
                ))}
                <div className="flex justify-between pt-2 border-t font-semibold text-sm px-1">
                  <span>Orders: ${filteredOrderTotal.toFixed(2)}</span>
                  <span className="text-green-600">Commission: ${filteredCommissionTotal.toFixed(2)}</span>
                </div>
              </div>

              {/* Desktop Table View */}
              <div className="hidden sm:block overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Commission Date</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Order Total</TableHead>
                      <TableHead className="text-right">Rate %</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCommissions.map((commission) => (
                      <TableRow key={commission.id}>
                        <TableCell>
                          {format(parseLocalDate(commission.order_date), 'MMM d, yyyy')}
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
                        <TableCell>{commission.order?.customer?.business_name || '—'}</TableCell>
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
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={3} className="font-semibold">Totals</TableCell>
                      <TableCell className="text-right font-semibold">
                        ${filteredOrderTotal.toFixed(2)}
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-right font-semibold">
                        ${filteredCommissionTotal.toFixed(2)}
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </>
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-xs text-muted-foreground">
                        <span>Cases: {item.quantity}</span>
                        <span className="text-right">Unit: ${Number(item.unit_price).toFixed(2)}</span>
                        <span>Line Total: ${Number(item.line_total).toFixed(2)}</span>
                        <span className="text-right">Rate: {Number(item.commission_rate).toFixed(1)}%</span>
                      </div>
                      <p className="text-sm font-medium text-right">Commission: ${Number(item.commission_amount).toFixed(2)}</p>
                    </CardContent>
                  </Card>
                ))}
                <div className="flex justify-between pt-2 border-t font-semibold text-sm">
                  <span>Total: ${selectedCommission?.order_total?.toFixed(2) || '0.00'}</span>
                  <span>Commission: ${selectedCommission?.commission_amount?.toFixed(2) || '0.00'}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              Failed to load order details
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
