'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommissionRow {
  id: string
  salesperson_id: string
  order_id: string
  order_date: string
  order_total: number
  rate_applied: number
  commission_amount: number
  status: string
  paid_at: string | null
  paid_by: string | null
  notes: string | null
  created_at: string
  updated_at: string
  salesperson: { id: string; full_name: string } | null
  order: {
    id: string
    order_number: string
    customer: { business_name: string } | null
  } | null
  paid_by_user: { id: string; full_name: string } | null
}

export interface SalespersonOption {
  id: string
  full_name: string
  role: string
}

export interface CommissionRateRow {
  id: string
  salesperson_id: string | null
  product_type_id: string | null
  sku_id: string | null
  min_unit_price: number | null
  rate_percent: number
  effective_from: string | null
  effective_to: string | null
  created_at: string
  salesperson: { id: string; full_name: string } | null
  product_type: { id: string; name: string } | null
  sku: { id: string; code: string; name: string } | null
}

export interface ProductTypeOption {
  id: string
  name: string
  [key: string]: unknown
}

export interface SkuOption {
  id: string
  code: string
  name: string
  product_type_id: string | null
}

export interface OrderDetail {
  id: string
  order_number: string
  status: string
  order_date: string | null
  delivery_date: string | null
  notes: string | null
  customer: { business_name: string; license_name: string | null; city: string | null } | null
  order_items: Array<{
    id: string
    sku_id: string
    quantity: number
    unit_price: number
    line_total: number
    sku: { code: string; name: string } | null
  }>
}

export interface CommissionBreakdownItem {
  order_item_id: string
  sku_code: string
  sku_name: string
  quantity: number
  unit_price: number
  line_total: number
  commission_rate: number
  commission_amount: number
}

// ---------------------------------------------------------------------------
// Admin/management reads (commissions report + rates pages)
// ---------------------------------------------------------------------------

/**
 * Fetch all commissions with salesperson, order, and paid_by joins.
 * Only callable by admin or management.
 */
export async function getCommissions(): Promise<
  { data: CommissionRow[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('commissions')
    .select(`
      *,
      salesperson:profiles!commissions_salesperson_id_fkey(id, full_name),
      order:orders(id, order_number, customer:customers(business_name)),
      paid_by_user:profiles!commissions_paid_by_fkey(id, full_name)
    `)
    .order('order_date', { ascending: false })

  if (error) {
    console.error('[commissions] getCommissions error:', error)
    return { error: 'Failed to load commissions' }
  }

  return { data: (data ?? []) as CommissionRow[] }
}

/**
 * Fetch salespeople (sales + agent roles) for the filter dropdown.
 * Only callable by admin or management.
 */
export async function getSalespeople(): Promise<
  { data: SalespersonOption[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('profiles')
    .select('id, full_name, role')
    .in('role', ['sales', 'agent'])
    .order('full_name')

  if (error) {
    console.error('[commissions] getSalespeople error:', error)
    return { error: 'Failed to load salespeople' }
  }

  return { data: (data ?? []) as SalespersonOption[] }
}

/**
 * Fetch order detail and commission breakdown for a given order.
 * Only callable by admin or management (used in the commissions report page).
 */
export async function getOrderDetailForAdmin(orderId: string, salespersonId: string): Promise<
  | { order: OrderDetail; breakdown: CommissionBreakdownItem[]; error?: never }
  | { order?: never; breakdown?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const [orderRes, breakdownRes] = await Promise.all([
    db
      .from('orders')
      .select(`
        *,
        customer:customers(business_name, license_name, city),
        order_items(id, sku_id, quantity, unit_price, line_total, sku:skus(code, name))
      `)
      .eq('id', orderId)
      .single(),
    db.rpc('get_order_commission_breakdown', {
      p_order_id: orderId,
      p_salesperson_id: salespersonId,
    }),
  ])

  if (orderRes.error) {
    console.error('[commissions] getOrderDetailForAdmin order error:', orderRes.error)
    return { error: 'Failed to load order details' }
  }

  return {
    order: orderRes.data as OrderDetail,
    breakdown: (breakdownRes.data ?? []) as CommissionBreakdownItem[],
  }
}

// ---------------------------------------------------------------------------
// Commission mutations (admin/management only)
// ---------------------------------------------------------------------------

/**
 * Mark a single commission as approved.
 * Only callable by admin or management.
 */
export async function approveCommission(commissionId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('commissions')
    .update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', commissionId)

  if (error) {
    console.error('[commissions] approveCommission error:', error)
    return { error: 'Failed to approve commission' }
  }

  return {}
}

/**
 * Mark a single commission as paid with a payment date.
 * Only callable by admin or management.
 */
export async function markCommissionPaid(commissionId: string, paidDate: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('commissions')
    .update({
      status: 'paid',
      paid_at: paidDate,
      paid_by: auth.session.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', commissionId)

  if (error) {
    console.error('[commissions] markCommissionPaid error:', error)
    return { error: 'Failed to mark commission as paid' }
  }

  return {}
}

/**
 * Revert a commission to an earlier status (undo an accidental approve/pay).
 * Allowed transitions: paid -> approved, paid -> pending, approved -> pending.
 * Clears paid_at/paid_by whenever the commission leaves the 'paid' status, since
 * those columns should only be set for commissions that are currently paid.
 * Does not conflict with the order-delivery commission trigger
 * (create_commission_on_delivery), which only INSERTs a new commission row and
 * skips entirely if one already exists for the order — it never touches status.
 * Only callable by admin or management.
 */
export async function revertCommissionStatus(
  commissionId: string,
  targetStatus: 'pending' | 'approved'
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data: current, error: fetchError } = await db
    .from('commissions')
    .select('status')
    .eq('id', commissionId)
    .single()

  if (fetchError || !current) {
    console.error('[commissions] revertCommissionStatus fetch error:', fetchError)
    return { error: 'Commission not found' }
  }

  const validTransitions: Record<string, string[]> = {
    paid: ['approved', 'pending'],
    approved: ['pending'],
  }

  if (!validTransitions[current.status]?.includes(targetStatus)) {
    return { error: `Cannot revert commission from '${current.status}' to '${targetStatus}'` }
  }

  const update: Record<string, unknown> = {
    status: targetStatus,
    updated_at: new Date().toISOString(),
  }

  // Clear payment info whenever we leave the 'paid' status
  if (current.status === 'paid') {
    update.paid_at = null
    update.paid_by = null
  }

  const { error } = await db
    .from('commissions')
    .update(update)
    .eq('id', commissionId)

  if (error) {
    console.error('[commissions] revertCommissionStatus error:', error)
    return { error: 'Failed to revert commission status' }
  }

  return {}
}

/**
 * Save or update the notes field on a commission.
 * Only callable by admin or management.
 */
export async function saveCommissionNote(commissionId: string, notes: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('commissions')
    .update({
      notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', commissionId)

  if (error) {
    console.error('[commissions] saveCommissionNote error:', error)
    return { error: 'Failed to save note' }
  }

  return {}
}

/**
 * Bulk mark multiple commissions as paid with a shared payment date.
 * Only callable by admin or management.
 */
export async function bulkMarkCommissionsPaid(commissionIds: string[], paidDate: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  if (commissionIds.length === 0) return { error: 'No commissions selected' }

  const db = await createServiceClient()

  const { error } = await db
    .from('commissions')
    .update({
      status: 'paid',
      paid_at: paidDate,
      paid_by: auth.session.userId,
      updated_at: new Date().toISOString(),
    })
    .in('id', commissionIds)

  if (error) {
    console.error('[commissions] bulkMarkCommissionsPaid error:', error)
    return { error: 'Failed to mark commissions as paid' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Commission rates (admin/management only)
// ---------------------------------------------------------------------------

/**
 * Fetch all commission rates with salesperson, product type, and SKU joins.
 * Only callable by admin or management.
 */
export async function getCommissionRates(): Promise<
  { data: CommissionRateRow[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('commission_rates')
    .select(`
      *,
      salesperson:profiles!commission_rates_salesperson_id_fkey(id, full_name),
      product_type:product_types(id, name),
      sku:skus(id, code, name)
    `)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[commissions] getCommissionRates error:', error)
    return { error: 'Failed to load commission rates' }
  }

  return { data: (data ?? []) as CommissionRateRow[] }
}

/**
 * Fetch product types for the rate form dropdowns.
 * Only callable by admin or management.
 */
export async function getProductTypes(): Promise<
  { data: ProductTypeOption[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('product_types')
    .select('*')
    .order('name')

  if (error) {
    console.error('[commissions] getProductTypes error:', error)
    return { error: 'Failed to load product types' }
  }

  return { data: (data ?? []) as ProductTypeOption[] }
}

/**
 * Fetch active SKUs for the rate form dropdowns.
 * Only callable by admin or management.
 */
export async function getSkus(): Promise<
  { data: SkuOption[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('skus')
    .select('id, code, name, product_type_id')
    .eq('status', 'active')
    .order('code')

  if (error) {
    console.error('[commissions] getSkus error:', error)
    return { error: 'Failed to load SKUs' }
  }

  return { data: (data ?? []) as SkuOption[] }
}

export interface UpsertRateInput {
  salesperson_id: string | null
  product_type_id: string | null
  sku_id: string | null
  min_unit_price: number | null
  rate_percent: number
  effective_from: string
  effective_to: string | null
}

/**
 * Create a new commission rate.
 * Only callable by admin or management.
 */
export async function createCommissionRate(input: UpsertRateInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db.from('commission_rates').insert(input)

  if (error) {
    console.error('[commissions] createCommissionRate error:', error)
    return { error: 'Failed to create commission rate' }
  }

  return {}
}

/**
 * Update an existing commission rate.
 * Only callable by admin or management.
 */
export async function updateCommissionRate(rateId: string, input: UpsertRateInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('commission_rates')
    .update(input)
    .eq('id', rateId)

  if (error) {
    console.error('[commissions] updateCommissionRate error:', error)
    return { error: 'Failed to update commission rate' }
  }

  return {}
}

/**
 * Delete a commission rate by id.
 * Only callable by admin or management.
 */
export async function deleteCommissionRate(rateId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db.from('commission_rates').delete().eq('id', rateId)

  if (error) {
    console.error('[commissions] deleteCommissionRate error:', error)
    return { error: 'Failed to delete commission rate' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// My commissions (sales rep's own view — scoped to session.userId)
// ---------------------------------------------------------------------------

/**
 * Fetch the current user's own commissions.
 * Allowed roles: sales, agent, management, admin.
 * CRITICAL: salesperson_id filter is derived from the server session — the
 * caller cannot pass an arbitrary userId to read someone else's commissions.
 */
export async function getMyCommissions(): Promise<
  { data: CommissionRow[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(['sales', 'agent', 'management', 'admin'])
  if (!auth.authorized) return { error: auth.reason }

  // Use the server-verified session userId — never trust a client-passed id
  const sessionUserId = auth.session.userId

  const db = await createServiceClient()

  const { data, error } = await db
    .from('commissions')
    .select(`
      *,
      salesperson:profiles!commissions_salesperson_id_fkey(id, full_name),
      order:orders(id, order_number, customer:customers(business_name))
    `)
    .eq('salesperson_id', sessionUserId)
    .order('order_date', { ascending: false })

  if (error) {
    console.error('[commissions] getMyCommissions error:', error)
    return { error: 'Failed to load commissions' }
  }

  return { data: (data ?? []) as CommissionRow[] }
}

/**
 * Fetch order detail for a commission in the my-commissions view.
 * Verifies the commission belongs to the session user before returning order data.
 * Allowed roles: sales, agent, management, admin.
 */
export async function getMyOrderDetail(orderId: string, commissionId: string): Promise<
  | { order: OrderDetail; breakdown: CommissionBreakdownItem[]; error?: never }
  | { order?: never; breakdown?: never; error: string }
> {
  const auth = await requireRole(['sales', 'agent', 'management', 'admin'])
  if (!auth.authorized) return { error: auth.reason }

  const sessionUserId = auth.session.userId
  const db = await createServiceClient()

  // Verify this commission belongs to the session user before exposing order data
  const { data: commission, error: commissionError } = await db
    .from('commissions')
    .select('id, salesperson_id')
    .eq('id', commissionId)
    .eq('salesperson_id', sessionUserId)
    .single()

  if (commissionError || !commission) {
    return { error: 'Commission not found or access denied' }
  }

  const [orderRes, breakdownRes] = await Promise.all([
    db
      .from('orders')
      .select(`
        *,
        customer:customers(business_name, license_name, city),
        order_items(id, sku_id, quantity, unit_price, line_total, sku:skus(code, name))
      `)
      .eq('id', orderId)
      .single(),
    db.rpc('get_order_commission_breakdown', {
      p_order_id: orderId,
      p_salesperson_id: sessionUserId,
    }),
  ])

  if (orderRes.error) {
    console.error('[commissions] getMyOrderDetail order error:', orderRes.error)
    return { error: 'Failed to load order details' }
  }

  return {
    order: orderRes.data as OrderDetail,
    breakdown: (breakdownRes.data ?? []) as CommissionBreakdownItem[],
  }
}
