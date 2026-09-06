import { getDashboardSummary } from '@/actions/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  MessageSquare,
  CheckSquare,
  ShoppingCart,
  Building2,
  ArrowRight,
  Calendar,
  DollarSign
} from 'lucide-react'
import Link from 'next/link'
import { format } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import type { Task, Order } from '@/types/database'

function getPriorityBadge(priority: number) {
  switch (priority) {
    case 1:
      return <Badge variant="destructive">High</Badge>
    case 2:
      return <Badge variant="default">Medium</Badge>
    case 3:
      return <Badge variant="secondary">Low</Badge>
    default:
      return null
  }
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'pending':
      return <Badge variant="outline">Pending</Badge>
    case 'submitted':
      return <Badge variant="default">Submitted</Badge>
    case 'approved':
      return <Badge variant="default" className="bg-green-600">Approved</Badge>
    default:
      return null
  }
}

export default async function DashboardPage() {
  const result = await getDashboardSummary()

  if (result.error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Unable to load dashboard.</div>
      </div>
    )
  }

  // result.error was checked above; data is guaranteed present
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { stats, recentTasks, recentOrders } = result.data!

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back! Here&apos;s your overview.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Orders</CardTitle>
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalOrders}</div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${stats.monthlyRevenue.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Tasks</CardTitle>
            <CheckSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.openTasks}</div>
            <p className="text-xs text-muted-foreground">Needs attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Communications</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.todayCommunications}</div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Tasks */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Upcoming Tasks</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard/tasks">
                  View all
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <CardDescription>Tasks that need your attention</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open tasks</p>
              ) : (
                recentTasks.map((task: Task) => (
                  <div key={task.id} className="flex items-start justify-between space-x-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors">
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium">{task.title}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        <span>Due {format(parseLocalDate(task.due_date), 'MMM d, yyyy')}</span>
                        {task.customer && (
                          <>
                            <span>•</span>
                            <span>{task.customer.business_name}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {getPriorityBadge(task.priority)}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Recent Orders</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard/orders">
                  View all
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <CardDescription>Latest order submissions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent orders</p>
              ) : (
                recentOrders.map((order: Order) => (
                  <div key={order.id} className="flex items-start justify-between space-x-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors">
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium">
                        {order.customer?.business_name || 'Unknown Dispensary'}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>${order.total_price.toFixed(2)}</span>
                        <span>•</span>
                        <span>{format(parseLocalDate(order.order_date), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                    {getStatusBadge(order.status)}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks you might want to do</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Button variant="outline" className="h-auto flex-col py-4" asChild>
              <Link href="/dashboard/communications/new">
                <MessageSquare className="h-5 w-5 mb-2" />
                <span className="text-xs">Log Communication</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col py-4" asChild>
              <Link href="/dashboard/tasks/new">
                <CheckSquare className="h-5 w-5 mb-2" />
                <span className="text-xs">Create Task</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col py-4" asChild>
              <Link href="/dashboard/orders/new">
                <ShoppingCart className="h-5 w-5 mb-2" />
                <span className="text-xs">New Order</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col py-4" asChild>
              <Link href="/dashboard/dispensaries">
                <Building2 className="h-5 w-5 mb-2" />
                <span className="text-xs">View Dispensaries</span>
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
