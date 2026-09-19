'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Building2, Phone, Mail, MapPin, FileText, MessageSquare, ShoppingCart, BarChart3, Plus, Edit, MoreHorizontal, Trash2, Search, Users } from 'lucide-react'
import Link from 'next/link'
import { useAuth, canCreateOrder, canEditOrder, canDeleteOrder, canAssignSales, canApproveOrder } from '@/lib/auth-context'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EditDispensarySheet } from '@/components/dispensary/edit-dispensary-sheet'
import { CommunicationSheet } from '@/components/communications/communication-sheet'
import { OrderSheet } from '@/components/orders/order-sheet'
import { OrderDeductionBreakdown } from '@/components/orders/order-deductions'
import { CustomerPricingSection } from '@/components/dispensary/customer-pricing'
import { DispensaryContacts } from '@/components/dispensaries/dispensary-contacts'
import { DispensaryProfile, Order } from '@/types/database'
import { parseLocalDate } from '@/lib/utils'
import { StatusBadgeDropdown } from '@/components/orders/status-badge-dropdown'
import { toast } from 'sonner'
import {
  getCustomer,
  getCustomerCommunications,
  getCustomerOrders,
  getSalesUsers,
  assignSalesRep,
  setCustomerActiveStatus,
  updateOrderStatus,
  deleteOrder,
  type CustomerDetail,
  type SalesUserRecord,
} from '@/actions/customers'

interface DispensaryProfileWithStats {
  id: string
  business_name: string
  license_name?: string | null
  address?: string | null
  city?: string | null
  phone_number?: string | null
  email?: string | null
  omma_license?: string | null
  ob_license?: string | null
  is_active?: boolean | null
  last_communication_date?: string | null
  last_order_date?: string | null
  total_orders_count?: number | null
  total_communications_count?: number | null
  total_revenue?: number | null
  assigned_sales_id?: string | null
  assigned_sales?: { id: string; name: string } | null
  created_at: string
  updated_at?: string | null
}

interface Communication {
  id: string
  interaction_date: string
  contact_method: string
  notes: string
  follow_up_required: boolean
  agent_name?: string
}

interface OrderWithAgent extends Order {
  agent_name?: string
}

export default function DispensaryDetailPage() {
  const params = useParams()
  const [dispensary, setDispensary] = useState<DispensaryProfileWithStats | null>(null)
  const [communications, setCommunications] = useState<Communication[]>([])
  const [orders, setOrders] = useState<OrderWithAgent[]>([])
  const [filteredOrders, setFilteredOrders] = useState<OrderWithAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [editDispensaryOpen, setEditDispensaryOpen] = useState(false)
  const [communicationSheetOpen, setCommunicationSheetOpen] = useState(false)
  const [orderSheetOpen, setOrderSheetOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<OrderWithAgent | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [salesUsers, setSalesUsers] = useState<SalesUserRecord[]>([])
  const [updatingSales, setUpdatingSales] = useState(false)
  const { user } = useAuth()

  const dispensaryId = params.id as string
  const userRole = user?.role || 'agent'

  const fetchDispensary = useCallback(async () => {
    const result = await getCustomer(dispensaryId)
    if (result.data) {
      setDispensary(result.data as DispensaryProfileWithStats)
    } else {
      console.error('Error fetching customer:', result.error)
    }
  }, [dispensaryId])

  const fetchCommunications = useCallback(async () => {
    const result = await getCustomerCommunications(dispensaryId)
    if (result.data) {
      const formattedComms = result.data.map((comm) => ({
        ...comm,
        agent_name: (comm.agent as { name: string })?.name || 'Unknown Agent',
      })) as Communication[]
      setCommunications(formattedComms)
    } else {
      console.error('Error fetching communications:', result.error)
    }
  }, [dispensaryId])

  const fetchOrders = useCallback(async () => {
    const result = await getCustomerOrders(dispensaryId)
    if (result.data) {
      const formattedOrders = result.data.map((order) => ({
        ...order,
        order_id: order.order_number,
        dispensary_id: order.customer_id,
        final_delivery_date: order.confirmed_delivery_date,
        agent_name: (order.agent as { name: string })?.name || 'Unknown Agent',
      })) as OrderWithAgent[]
      setOrders(formattedOrders)
    } else {
      console.error('Error fetching orders:', result.error)
    }
    setLoading(false)
  }, [dispensaryId])

  const fetchSalesUsersData = useCallback(async () => {
    const result = await getSalesUsers()
    if (result.data) setSalesUsers(result.data)
  }, [])

  useEffect(() => {
    const loadData = async () => {
      await fetchDispensary()
      await fetchCommunications()
      await fetchOrders()
      await fetchSalesUsersData()
    }
    loadData()
  }, [fetchDispensary, fetchCommunications, fetchOrders, fetchSalesUsersData])

  useEffect(() => {
    filterOrders()
  }, [orders, searchTerm, filterStatus])

  const filterOrders = () => {
    let filtered = [...orders]

    if (searchTerm) {
      filtered = filtered.filter(order =>
        order.order_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.order_notes?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.agent_name?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter(order => order.status === filterStatus)
    }

    setFilteredOrders(filtered)
  }

  const formatDate = (dateString: string) => {
    // Use parseLocalDate for date-only strings (YYYY-MM-DD) to avoid UTC off-by-one
    const date = dateString.includes('T') ? new Date(dateString) : parseLocalDate(dateString)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount)
  }

  const canManageDispensaries = ['sales', 'agent', 'management', 'admin'].includes(userRole)

  // Permission checks
  const userCanCreateOrder = canCreateOrder(userRole)
  const userCanEditOrder = canEditOrder(userRole)
  const userCanDeleteOrder = canDeleteOrder(userRole)
  const userCanAssignSales = canAssignSales(userRole)
  const canApproveOrders = canApproveOrder(userRole)

  // Sales users can only create orders for dispensaries they're assigned to
  const isAssignedToDispensary = dispensary?.assigned_sales_id === user?.id
  const canAddOrderForThisDispensary = userRole === 'sales'
    ? isAssignedToDispensary
    : userCanCreateOrder

  const handleSalesAssignment = async (salesId: string) => {
    setUpdatingSales(true)
    const result = await assignSalesRep(dispensaryId, salesId === 'unassigned' ? null : salesId)
    if (!result.error) {
      toast.success('Sales assignment updated')
      fetchDispensary()
    } else {
      console.error('Error updating sales assignment:', result.error)
      toast.error('Failed to update sales assignment')
    }
    setUpdatingSales(false)
  }

  const handleToggleActive = async (isActive: boolean) => {
    const result = await setCustomerActiveStatus(dispensaryId, isActive)
    if (!result.error) {
      toast.success(isActive ? 'Dispensary marked as active' : 'Dispensary marked as inactive')
      fetchDispensary()
    } else {
      console.error('Error updating active status:', result.error)
      toast.error('Failed to update active status')
    }
  }

  const handleDeleteOrder = async (order: OrderWithAgent) => {
    const result = await deleteOrder(order.id)
    if (!result.error) {
      toast.success('Order deleted successfully')
      fetchOrders()
    } else {
      console.error('Error deleting order:', result.error)
      toast.error('Failed to delete order. Please try again.')
    }
  }

  const handleEditOrder = (order: OrderWithAgent) => {
    setSelectedOrder(order)
    setOrderSheetOpen(true)
  }

  const quickUpdateStatus = async (orderId: string, newStatus: string) => {
    if (!canApproveOrders || !user) return

    const result = await updateOrderStatus(orderId, newStatus, user.id)
    if (!result.error) {
      toast.success(`Order status updated to ${newStatus}`)
      fetchOrders()
    } else {
      console.error('Error updating order status:', result.error)
      toast.error('Failed to update order status')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading dispensary details...</div>
      </div>
    )
  }

  if (!dispensary) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/dispensaries">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">Dispensary Not Found</h1>
            <p className="text-muted-foreground">The requested dispensary could not be found</p>
          </div>
        </div>
      </div>
    )
  }

  const totalOrders = orders?.length || 0
  const totalRevenue = (orders || []).reduce((sum, o) => sum + (o.total_price || 0), 0)
  const totalCommunications = communications?.length || 0

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/dispensaries">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl md:text-3xl font-bold">{dispensary.business_name}</h1>
          <p className="text-muted-foreground">Dispensary Profile</p>
        </div>
        <div className="flex items-center gap-3">
          {canManageDispensaries && (
            <div className="flex items-center gap-2">
              <Label htmlFor="active-toggle" className="text-sm text-muted-foreground">
                {dispensary.is_active === false ? 'Inactive' : 'Active'}
              </Label>
              <Switch
                id="active-toggle"
                checked={dispensary.is_active !== false}
                onCheckedChange={handleToggleActive}
              />
            </div>
          )}
          {canManageDispensaries && (
            <Button onClick={() => setEditDispensaryOpen(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Dispensary Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            {dispensary.business_name}
            {dispensary.is_active === false && (
              <Badge variant="destructive">Inactive</Badge>
            )}
          </CardTitle>
          {dispensary.license_name && (
            <p className="text-sm text-muted-foreground">
              License Name: {dispensary.license_name}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {dispensary.address && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground mt-1" />
                <div>
                  <p className="text-sm font-medium">Address</p>
                  <p className="text-sm text-muted-foreground">{dispensary.address}</p>
                </div>
              </div>
            )}

            {dispensary.phone_number && (
              <div className="flex items-start gap-2">
                <Phone className="h-4 w-4 text-muted-foreground mt-1" />
                <div>
                  <p className="text-sm font-medium">Phone</p>
                  <a
                    href={`tel:${dispensary.phone_number}`}
                    className="text-sm text-primary hover:underline"
                  >
                    {dispensary.phone_number}
                  </a>
                </div>
              </div>
            )}

            {dispensary.email && (
              <div className="flex items-start gap-2">
                <Mail className="h-4 w-4 text-muted-foreground mt-1" />
                <div>
                  <p className="text-sm font-medium">Email</p>
                  <a
                    href={`mailto:${dispensary.email}`}
                    className="text-sm text-primary hover:underline"
                  >
                    {dispensary.email}
                  </a>
                </div>
              </div>
            )}

            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 text-muted-foreground mt-1" />
              <div>
                <p className="text-sm font-medium">Licenses</p>
                <div className="flex flex-wrap gap-1">
                  {dispensary.omma_license && (
                    <Badge variant="outline" className="text-xs">
                      OMMA: {dispensary.omma_license}
                    </Badge>
                  )}
                  {dispensary.ob_license && (
                    <Badge variant="outline" className="text-xs">
                      OB: {dispensary.ob_license}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Sales Assignment */}
            <div className="flex items-start gap-2">
              <Users className="h-4 w-4 text-muted-foreground mt-1" />
              <div className="flex-1">
                <p className="text-sm font-medium mb-1">Assigned Sales</p>
                {userCanAssignSales ? (
                  <Select
                    value={dispensary.assigned_sales_id || 'unassigned'}
                    onValueChange={(value) => handleSalesAssignment(value)}
                    disabled={updatingSales}
                  >
                    <SelectTrigger className="w-[180px] h-8 text-xs">
                      <SelectValue placeholder="Select sales rep" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {salesUsers.map((salesUser) => (
                        <SelectItem key={salesUser.id} value={salesUser.id}>
                          {salesUser.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {dispensary.assigned_sales?.name || 'Unassigned'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <div className="relative rounded-md overflow-x-auto h-10 bg-muted">
          <TabsList className="absolute flex flex-row justify-stretch w-max min-w-full">
            <TabsTrigger value="overview" className="flex-1">Overview</TabsTrigger>
            <TabsTrigger value="pricing" className="flex-1">Pricing</TabsTrigger>
            <TabsTrigger value="communications" className="flex-1">Communications</TabsTrigger>
            <TabsTrigger value="orders" className="flex-1">Orders</TabsTrigger>
            <TabsTrigger value="analytics" className="flex-1">Analytics</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Total Orders</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {totalOrders}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Last order: {dispensary.last_order_date ? formatDate(dispensary.last_order_date) : 'Never'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Total Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCurrency(Number(totalRevenue.toFixed(2)))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  All time revenue
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Communications</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {totalCommunications}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Last contact: {dispensary.last_communication_date ? formatDate(dispensary.last_communication_date) : 'Never'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Customer Since</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatDate(dispensary.created_at)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {Math.floor((Date.now() - new Date(dispensary.created_at).getTime()) / (1000 * 60 * 60 * 24))} days ago
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Contacts Section */}
          <DispensaryContacts dispensaryId={dispensaryId} />

          {/* Recent Activity */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Recent Communications</CardTitle>
                  <Button variant="outline" size="sm" onClick={() => setCommunicationSheetOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {communications.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No communications logged yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {communications.slice(0, 5).map((comm) => (
                      <div key={comm.id} className="flex items-start gap-3 p-3 border rounded-lg">
                        <MessageSquare className="h-4 w-4 text-muted-foreground mt-1" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-xs">
                              {comm.contact_method}
                            </Badge>
                            {comm.follow_up_required && (
                              <Badge variant="secondary" className="text-xs">
                                Follow-up Required
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {comm.notes}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate(comm.interaction_date)} • {comm.agent_name}
                          </p>
                        </div>
                      </div>
                    ))}
                    {communications.length > 5 && (
                      <div className="text-center">
                        <Button variant="ghost" size="sm" onClick={() => setActiveTab('communications')}>
                          View All Communications ({communications.length})
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Recent Orders</CardTitle>
                  {canAddOrderForThisDispensary && (
                    <Button variant="outline" size="sm" onClick={() => setOrderSheetOpen(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {orders.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <ShoppingCart className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No orders placed yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {orders.slice(0, 5).map((order) => (
                      <div key={order.id} className="flex items-start gap-3 p-3 border rounded-lg">
                        <ShoppingCart className="h-4 w-4 text-muted-foreground mt-1" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <StatusBadgeDropdown orderId={order.id} currentStatus={order.status} canChangeStatus={canApproveOrders} onStatusChange={quickUpdateStatus} />
                            <span className="text-sm font-medium">
                              {formatCurrency(order.total_price)}
                            </span>
                          </div>
                          {order.order_notes && (
                            <p className="text-sm text-muted-foreground line-clamp-1">
                              {order.order_notes}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate(order.order_date)} • {order.agent_name}
                          </p>
                        </div>
                      </div>
                    ))}
                    {orders.length > 5 && (
                      <div className="text-center">
                        <Button variant="ghost" size="sm" onClick={() => setActiveTab('orders')}>
                          View All Orders ({orders.length})
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="pricing" className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-medium">Default Pricing</h3>
              <p className="text-sm text-muted-foreground">
                Set custom pricing for this customer. Item prices override category prices.
              </p>
            </div>
          </div>

          <CustomerPricingSection
            customerId={dispensaryId}
            canManage={canManageDispensaries}
          />
        </TabsContent>

        <TabsContent value="communications" className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-medium">All Communications ({communications.length})</h3>
            <Button onClick={() => setCommunicationSheetOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Log Communication
            </Button>
          </div>

          {communications.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground mb-4">No communications logged yet</p>
                <Button onClick={() => setCommunicationSheetOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Log First Communication
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {communications.map((comm) => (
                <Card key={comm.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {comm.contact_method}
                        </Badge>
                        {comm.follow_up_required && (
                          <Badge variant="secondary">
                            Follow-up Required
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {formatDate(comm.interaction_date)}
                      </span>
                    </div>
                    <p className="text-sm mb-3">{comm.notes}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>By: {comm.agent_name}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="orders" className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-medium">All Orders ({filteredOrders.length})</h3>
            {canAddOrderForThisDispensary && (
              <Button onClick={() => { setSelectedOrder(null); setOrderSheetOpen(true); }}>
                <Plus className="mr-2 h-4 w-4" />
                Create Order
              </Button>
            )}
          </div>

          {/* Search and Filters */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                    <SelectItem value="all">All Orders</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="submitted">Submitted</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center text-sm text-muted-foreground">
                  {filteredOrders.length} of {orders.length} orders
                </div>
              </div>
            </CardContent>
          </Card>

          {filteredOrders.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ShoppingCart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground mb-4">
                  {searchTerm || filterStatus !== 'all'
                    ? 'No orders found matching your filters'
                    : 'No orders placed yet'}
                </p>
                {canAddOrderForThisDispensary && (
                  <Button onClick={() => { setSelectedOrder(null); setOrderSheetOpen(true); }}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create First Order
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden md:table-cell">Requested Date</TableHead>
                        <TableHead>Total Cost</TableHead>
                        <TableHead className="hidden lg:table-cell">Delivery Date</TableHead>
                        <TableHead className="w-[50px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredOrders.map((order) => (
                        <TableRow key={order.id} className="hover:bg-muted/50">
                          <TableCell>
                            <div className="font-medium">
                              {order.order_id || '—'}
                            </div>
                            <div className="text-sm text-muted-foreground md:hidden">
                              {formatDate(order.order_date)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadgeDropdown orderId={order.id} currentStatus={order.status} canChangeStatus={canApproveOrders} onStatusChange={quickUpdateStatus} />
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <div className="text-sm">
                              {formatDate(order.order_date)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              By: {order.agent_name}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">
                              {formatCurrency(order.total_price)}
                            </span>
                            {/* SPRO-148 — renders nothing unless a deduction exists */}
                            <OrderDeductionBreakdown order={order} className="mt-1 space-y-0.5" />
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <div className="text-sm">
                              {order.final_delivery_date
                                ? formatDate(order.final_delivery_date)
                                : order.requested_delivery_date
                                  ? formatDate(order.requested_delivery_date)
                                  : '—'
                              }
                            </div>
                            {order.final_delivery_date && order.requested_delivery_date && (
                              <div className="text-xs text-muted-foreground">
                                Requested: {formatDate(order.requested_delivery_date)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {(userCanEditOrder || userCanDeleteOrder) && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                    <span className="sr-only">Open menu</span>
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {userCanEditOrder && (
                                    <DropdownMenuItem onClick={() => handleEditOrder(order)}>
                                      <Edit className="h-4 w-4 mr-2" />
                                      Edit Order
                                    </DropdownMenuItem>
                                  )}
                                  {userCanDeleteOrder && (
                                    <AlertDialog>
                                      <AlertDialogTrigger asChild>
                                        <DropdownMenuItem
                                          className="text-red-600 focus:text-red-600"
                                          onSelect={(e) => e.preventDefault()}
                                        >
                                          <Trash2 className="h-4 w-4 mr-2" />
                                          Delete Order
                                        </DropdownMenuItem>
                                      </AlertDialogTrigger>
                                      <AlertDialogContent>
                                        <AlertDialogHeader>
                                          <AlertDialogTitle>Delete Order</AlertDialogTitle>
                                          <AlertDialogDescription>
                                            Are you sure you want to delete this order ({order.order_id || 'Untitled Order'})? This action cannot be undone and will remove all order items as well.
                                          </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                                          <AlertDialogAction
                                            onClick={() => handleDeleteOrder(order)}
                                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                          >
                                            Delete Order
                                          </AlertDialogAction>
                                        </AlertDialogFooter>
                                      </AlertDialogContent>
                                    </AlertDialog>
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
          )}
        </TabsContent>

        <TabsContent value="analytics" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Order Analytics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Total Orders</span>
                    <span className="font-medium">{totalOrders}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Total Revenue</span>
                    <span className="font-medium">
                      {formatCurrency(totalRevenue)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Average Order Value</span>
                    <span className="font-medium">
                      {totalOrders && totalRevenue
                        ? formatCurrency(totalRevenue / totalOrders)
                        : '$0.00'
                      }
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Last Order</span>
                    <span className="font-medium">
                      {dispensary.last_order_date ? formatDate(dispensary.last_order_date) : 'Never'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  Communication Analytics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Total Communications</span>
                    <span className="font-medium">{totalCommunications}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Last Contact</span>
                    <span className="font-medium">
                      {dispensary.last_communication_date
                        ? formatDate(dispensary.last_communication_date)
                        : 'Never'
                      }
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Days Since Last Contact</span>
                    <span className="font-medium">
                      {dispensary.last_communication_date
                        ? Math.floor((Date.now() - new Date(dispensary.last_communication_date).getTime()) / (1000 * 60 * 60 * 24))
                        : 'N/A'
                      }
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Sheet Components */}
      <EditDispensarySheet
        open={editDispensaryOpen}
        onClose={() => setEditDispensaryOpen(false)}
        dispensary={dispensary as DispensaryProfile | null}
        onSuccess={() => {
          fetchDispensary()
          setEditDispensaryOpen(false)
        }}
      />

      <CommunicationSheet
        open={communicationSheetOpen}
        onClose={() => setCommunicationSheetOpen(false)}
        dispensaryId={dispensaryId}
        onSuccess={() => {
          fetchCommunications()
          setCommunicationSheetOpen(false)
        }}
      />

      <OrderSheet
        open={orderSheetOpen}
        onClose={() => { setOrderSheetOpen(false); setSelectedOrder(null); }}
        customerId={dispensaryId}
        order={selectedOrder ? {
          id: selectedOrder.id,
          order_number: selectedOrder.order_id,
          customer_id: selectedOrder.dispensary_id || dispensaryId,
          agent_id: selectedOrder.agent_id,
          order_date: selectedOrder.order_date,
          order_notes: selectedOrder.order_notes,
          requested_delivery_date: selectedOrder.requested_delivery_date,
          status: selectedOrder.status,
          total_price: selectedOrder.total_price,
          approved_by: selectedOrder.approved_by,
          approved_at: selectedOrder.approved_at,
          created_at: selectedOrder.created_at,
          updated_at: selectedOrder.updated_at,
          last_edited_at: selectedOrder.last_edited_at,
          last_edited_by: selectedOrder.last_edited_by,
          // SPRO-148 — carried through so the sheet can preserve/edit/remove
          // the deductions already on the order instead of silently dropping them.
          discount_amount: selectedOrder.discount_amount,
          discount_reason: selectedOrder.discount_reason,
          credit_amount: selectedOrder.credit_amount,
          credit_reason: selectedOrder.credit_reason,
        } : undefined}
        onSuccess={() => {
          fetchOrders()
          setOrderSheetOpen(false)
          setSelectedOrder(null)
        }}
      />
    </div>
  )
}
