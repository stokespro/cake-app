'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import type { Task, Order } from '@/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  stats: {
    totalOrders: number
    pendingTasks: number
    todayCommunications: number
    monthlyRevenue: number
  }
  recentTasks: Task[]
  recentOrders: Order[]
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch all data needed by the dashboard home page.
 *
 * Gate: any authenticated user (all roles have access to the dashboard).
 * Scoping: every query is filtered to the calling user's own id — a user only
 * ever sees their own tasks, orders, and communications.
 */
export async function getDashboardSummary(): Promise<
  { data: DashboardSummary; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole([
    'admin',
    'management',
    'sales',
    'agent',
    'vault',
    'packaging',
    'standard',
  ])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const userId = auth.session.userId

  const today = new Date().toISOString().split('T')[0]
  const firstDayOfMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1
  ).toISOString()

  // Run all queries in parallel
  const [
    pendingTasksResult,
    todayCommsResult,
    monthlyOrdersResult,
    recentTasksResult,
    recentOrdersResult,
  ] = await Promise.all([
    // Count open (todo, non-archived) tasks owned by this user
    db
      .from('sales_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', userId)
      .eq('status', 'todo')
      .is('archived_at', null),

    // Count today's communications logged by this user
    db
      .from('communications')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', userId)
      .gte('interaction_date', today),

    // Orders this month for revenue + count
    db
      .from('orders')
      .select('total_price')
      .eq('agent_id', userId)
      .gte('order_date', firstDayOfMonth),

    // Up to 5 upcoming open (todo, non-archived) tasks for this user
    db
      .from('sales_tasks')
      .select('*, customer:customers(business_name)')
      .eq('agent_id', userId)
      .eq('status', 'todo')
      .is('archived_at', null)
      .order('due_date', { ascending: true })
      .limit(5),

    // Up to 5 most recent orders for this user
    db
      .from('orders')
      .select('*, customer:customers(business_name)')
      .eq('agent_id', userId)
      .order('order_date', { ascending: false })
      .limit(5),
  ])

  if (pendingTasksResult.error) {
    console.error('[dashboard] pendingTasks error:', pendingTasksResult.error)
    return { error: 'Failed to load dashboard data' }
  }
  if (todayCommsResult.error) {
    console.error('[dashboard] todayComms error:', todayCommsResult.error)
    return { error: 'Failed to load dashboard data' }
  }
  if (monthlyOrdersResult.error) {
    console.error('[dashboard] monthlyOrders error:', monthlyOrdersResult.error)
    return { error: 'Failed to load dashboard data' }
  }
  if (recentTasksResult.error) {
    console.error('[dashboard] recentTasks error:', recentTasksResult.error)
    return { error: 'Failed to load dashboard data' }
  }
  if (recentOrdersResult.error) {
    console.error('[dashboard] recentOrders error:', recentOrdersResult.error)
    return { error: 'Failed to load dashboard data' }
  }

  const monthlyOrders = monthlyOrdersResult.data ?? []
  const monthlyRevenue = monthlyOrders.reduce(
    (sum, order) => sum + (order.total_price || 0),
    0
  )

  return {
    data: {
      stats: {
        totalOrders: monthlyOrders.length,
        pendingTasks: pendingTasksResult.count ?? 0,
        todayCommunications: todayCommsResult.count ?? 0,
        monthlyRevenue,
      },
      recentTasks: (recentTasksResult.data ?? []) as Task[],
      recentOrders: (recentOrdersResult.data ?? []) as Order[],
    },
  }
}
