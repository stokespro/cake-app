'use server'

import { requireRole } from '@/lib/auth/session'
import { roundCurrency, validateOrderDeductions } from '@/lib/orders/deductions'
import type { DeductionInput } from '@/lib/orders/deductions'
import { DEFAULT_UNITS_PER_CASE } from '@/lib/orders/line-items'
import { createServiceClient } from '@/lib/supabase/server'
import type { OrderStatus } from '@/types/database'

// Roles that can view orders — mirrors canViewSection('orders') in lib/auth-context.tsx
const VIEW_ROLES = ['sales', 'agent', 'management', 'admin'] as const

// Roles that can create orders — mirrors canCreateOrder()
const CREATE_ROLES = ['sales', 'management', 'admin'] as const

// Roles that can edit orders — mirrors canEditOrder()
const EDIT_ROLES = ['sales', 'agent', 'management', 'admin'] as const

// Roles that can approve/status-change orders — mirrors canApproveOrder()
const APPROVE_ROLES = ['management', 'admin'] as const

// Roles that can delete orders — mirrors canDeleteOrder()
const DELETE_ROLES = ['management', 'admin'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderSkuRecord {
  id: string
  code: string
  name: string
  price_per_unit: number | null
  units_per_case: number
  in_stock: boolean
  status?: string
  product_type_id?: string
}

export interface OrderRecord {
  id: string
  order_number?: string | null
  customer_id: string
  agent_id?: string | null
  order_date: string
  order_notes?: string | null
  requested_delivery_date?: string | null
  confirmed_delivery_date?: string | null
  delivered_at?: string | null
  status: OrderStatus
  /** Net of any order-level deduction — see lib/orders/deductions.ts (SPRO-148). */
  total_price: number
  // SPRO-148 order-level deductions — each pair is both-null or both-set.
  discount_amount?: number | null
  discount_reason?: string | null
  credit_amount?: number | null
  credit_reason?: string | null
  approved_by?: string | null
  approved_at?: string | null
  created_at: string
  updated_at: string
  last_edited_at?: string | null
  last_edited_by?: string | null
  payment_terms?: boolean | null
  terms_payment_date?: string | null
  terms_paid_at?: string | null
  customer?: {
    business_name: string
    license_name?: string | null
    omma_license?: string | null
    city?: string | null
    assigned_sales_id?: string | null
  } | null
  order_items?: OrderItemRecord[]
  // Legacy alias kept for UI compatibility
  dispensary?: OrderRecord['customer']
}

export interface OrderItemRecord {
  id: string
  order_id: string
  sku_id: string
  quantity: number
  unit_price?: number | null
  line_total: number
  created_at: string
  sku?: { code: string; name: string } | null
}

export interface CommissionRecord {
  order_id: string
  commission_amount: number
  status: string
}

export interface CustomerBasicRecord {
  id: string
  business_name: string
  license_name?: string | null
  omma_license?: string | null
  city?: string | null
  is_active?: boolean | null
  assigned_sales_id?: string | null
}

export interface CustomerPricingRecord {
  sku_id: string | null
  product_type_id: string | null
  price_per_unit: number
}

// No line_total on either input: line amounts are always derived server-side
// by priceLineItems() from the skus table, so a forged payload cannot set the
// amount persisted on an order item or the subtotal the deduction ceiling and
// the header total are computed from (SPRO-148).
export interface NewOrderItemInput {
  sku_id: string
  cases: number    // stored as quantity in DB
  unit_price: number
}

export interface UpdateOrderItemInput {
  id?: string      // undefined = new item; string = existing
  sku_id: string
  cases: number    // stored as quantity in DB
  unit_price: number | null
  _deleted?: boolean
}

// ---------------------------------------------------------------------------
// Server-authoritative line pricing (SPRO-148)
// ---------------------------------------------------------------------------

/** The shape every write path submits per line, before server pricing. */
interface SubmittedLineItem {
  sku_id: string
  cases: number
  unit_price?: number | null
  _deleted?: boolean
}

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

/**
 * Raised whenever a submitted line references a SKU row the server cannot find.
 * Shared by the pricing pass and the availability gate so both reject an
 * unknown SKU with the same wording.
 */
const MISSING_SKU_ERROR = 'Order item references a SKU that no longer exists.'

/**
 * Derives each line amount from server truth and returns the subtotal.
 *
 * The house pricing rule, shared by all three order forms, is
 * `line_total = cases x units_per_case x unit_price`. Cases and unit price are
 * accepted from the client — a manually typed unit price is a real workflow for
 * SKUs with no customer_pricing row — but `units_per_case` is read from the
 * skus table and the multiplication is redone here, so a submitted line amount
 * is never persisted and never feeds the subtotal, the deduction ceiling or
 * total_price.
 *
 * Returns the items in submission order, each carrying its derived line_total
 * (a deleted item gets 0 and is excluded from the subtotal).
 */
async function priceLineItems<T extends SubmittedLineItem>(
  db: ServiceClient,
  items: readonly T[] | null | undefined
): Promise<
  | { ok: true; items: Array<T & { line_total: number }>; subtotal: number }
  | { ok: false; error: string }
> {
  const submitted = items ?? []
  const skuIds = [...new Set(submitted.filter(item => !item._deleted).map(item => item.sku_id))]

  const unitsPerCase = new Map<string, number>()

  if (skuIds.length > 0) {
    const { data, error } = await db.from('skus').select('id, units_per_case').in('id', skuIds)

    if (error) {
      console.error('[orders] priceLineItems skus error:', error)
      return { ok: false, error: 'Failed to price order items' }
    }

    for (const sku of data ?? []) {
      unitsPerCase.set(sku.id, sku.units_per_case ?? DEFAULT_UNITS_PER_CASE)
    }
  }

  const priced: Array<T & { line_total: number }> = []
  let subtotal = 0

  for (const item of submitted) {
    if (item._deleted) {
      priced.push({ ...item, line_total: 0 })
      continue
    }

    const perCase = item.sku_id ? unitsPerCase.get(item.sku_id) : undefined
    if (perCase === undefined) {
      return { ok: false, error: MISSING_SKU_ERROR }
    }

    if (!Number.isInteger(item.cases) || item.cases <= 0) {
      return { ok: false, error: 'Order item quantity must be a whole number of cases greater than zero.' }
    }

    const unitPrice = item.unit_price ?? 0
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { ok: false, error: 'Order item unit price must be a valid, non-negative number.' }
    }

    const lineTotal = roundCurrency(item.cases * perCase * unitPrice)
    subtotal = roundCurrency(subtotal + lineTotal)
    priced.push({ ...item, line_total: lineTotal })
  }

  return { ok: true, items: priced, subtotal }
}

// ---------------------------------------------------------------------------
// Server-authoritative availability gate (SPRO-151)
// ---------------------------------------------------------------------------

/**
 * Rejects a creation payload that references a SKU which cannot be ordered.
 *
 * The new-order picker shows out-of-stock SKUs greyed out and unselectable, but
 * that is presentation: a hand-rolled server-action POST, a stale tab whose SKU
 * list predates the stock change, or a future picker regression all reach this
 * layer with an unorderable sku_id. `skus.in_stock` is the single source of
 * availability truth (maintained by the DB triggers in
 * supabase/migrations/*_derive_sku_in_stock.sql and its successors) — nothing
 * here parses SKU codes or recomputes inventory.
 *
 * A SKU passes only if its row exists, its status is 'active' and in_stock is
 * true, which is exactly the set getActiveSkus(true) offers.
 *
 * Creation paths only: an existing order may legitimately contain a SKU that
 * has since gone out of stock, and editing it must not become impossible.
 */
async function assertSkusAvailable(
  db: ServiceClient,
  items: readonly SubmittedLineItem[] | null | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const live = (items ?? []).filter(item => !item._deleted)

  // An empty sku_id can never resolve to a row; treat it as missing rather than
  // sending '' to a uuid column.
  if (live.some(item => !item.sku_id)) return { ok: false, error: MISSING_SKU_ERROR }

  const skuIds = [...new Set(live.map(item => item.sku_id))]
  if (skuIds.length === 0) return { ok: true }

  const { data, error } = await db
    .from('skus')
    .select('id, code, status, in_stock')
    .in('id', skuIds)

  if (error) {
    console.error('[orders] assertSkusAvailable skus error:', error)
    return { ok: false, error: 'Failed to verify SKU availability' }
  }

  const found = data ?? []
  const foundIds = new Set(found.map(sku => sku.id))

  // Every requested id must have come back. `id` is the primary key, so a
  // short result set means a row is genuinely absent, not deduplicated.
  if (skuIds.some(id => !foundIds.has(id))) return { ok: false, error: MISSING_SKU_ERROR }

  const unavailable = found.filter(sku => sku.status !== 'active' || sku.in_stock !== true)
  if (unavailable.length > 0) {
    // Code, not id — this string is shown to the person placing the order.
    const labels = unavailable.map(sku => sku.code ?? sku.id).sort().join(', ')
    return {
      ok: false,
      error: `These SKUs are unavailable and cannot be ordered: ${labels}. Remove them and try again.`,
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Read — fetch all orders (with sales-user scoping)
// ---------------------------------------------------------------------------

/**
 * Fetch orders for the orders list page.
 * sales/agent users only see orders for their assigned customers.
 * Identity is always derived from the server session — no client-passed userId.
 */
export async function getOrders(): Promise<
  | { data: OrderRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const isSalesUser = ['sales', 'agent'].includes(auth.session.role)

  let customerIds: string[] | null = null

  if (isSalesUser) {
    // Filter to customers assigned to the authenticated user — never trust a client-passed id
    const { data: assignedCustomers, error: custErr } = await db
      .from('customers')
      .select('id')
      .eq('assigned_sales_id', auth.session.userId)

    if (custErr) {
      console.error('[orders] getOrders assigned-customers error:', custErr)
      return { error: 'Failed to load orders' }
    }

    customerIds = (assignedCustomers ?? []).map(c => c.id)
  }

  let query = db
    .from('orders')
    .select(`
      *,
      customer:customers(business_name, license_name, omma_license, city, assigned_sales_id),
      order_items(
        id,
        sku_id,
        quantity,
        unit_price,
        line_total,
        sku:skus(code, name)
      )
    `)
    .order('requested_delivery_date', { ascending: true })

  if (isSalesUser && customerIds !== null) {
    if (customerIds.length === 0) {
      // No assigned customers — return empty list
      return { data: [] }
    }
    query = query.in('customer_id', customerIds)
  }

  const { data, error } = await query

  if (error) {
    console.error('[orders] getOrders error:', error)
    return { error: 'Failed to load orders' }
  }

  // Add legacy alias expected by the UI
  const mapped = (data ?? []).map(order => ({
    ...order,
    dispensary: order.customer,
  })) as OrderRecord[]

  return { data: mapped }
}

// ---------------------------------------------------------------------------
// Read — fetch a single order (for post-save refresh)
// ---------------------------------------------------------------------------

export async function getOrder(orderId: string): Promise<
  | { data: OrderRecord; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('orders')
    .select(`
      *,
      customer:customers(business_name, license_name, omma_license, city, assigned_sales_id),
      order_items(
        id,
        sku_id,
        quantity,
        unit_price,
        line_total,
        sku:skus(code, name)
      )
    `)
    .eq('id', orderId)
    .single()

  if (error || !data) {
    console.error('[orders] getOrder error:', error)
    return { error: 'Order not found' }
  }

  return {
    data: { ...data, dispensary: data.customer } as OrderRecord,
  }
}

// ---------------------------------------------------------------------------
// Read — SKUs for the orders page edit form
// ---------------------------------------------------------------------------

/**
 * Fetch SKUs for the inline edit SKU picker (all SKUs with pricing info).
 */
export async function getOrderSkus(): Promise<
  | { data: OrderSkuRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('skus')
    .select('id, code, name, price_per_unit, units_per_case, in_stock, status, product_type_id')
    .neq('status', 'discontinued')
    .order('code')

  if (error) {
    console.error('[orders] getOrderSkus error:', error)
    return { error: 'Failed to load SKUs' }
  }

  return { data: (data ?? []) as OrderSkuRecord[] }
}

/**
 * Fetch active in-stock SKUs for the new-order / order-sheet SKU picker.
 */
export async function getActiveSkus(inStockOnly: boolean = true): Promise<
  | { data: OrderSkuRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('skus')
    .select('id, code, name, price_per_unit, units_per_case, in_stock, status, product_type_id')
    .eq('status', 'active')
    .order('code')

  if (inStockOnly) {
    query = query.eq('in_stock', true)
  }

  const { data, error } = await query

  if (error) {
    console.error('[orders] getActiveSkus error:', error)
    return { error: 'Failed to load SKUs' }
  }

  return { data: (data ?? []) as OrderSkuRecord[] }
}

// ---------------------------------------------------------------------------
// Read — customers list for order creation (paginated)
// ---------------------------------------------------------------------------

export async function getOrderCustomers(): Promise<
  | { data: CustomerBasicRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const allCustomers: CustomerBasicRecord[] = []
  let from = 0
  const batchSize = 1000

  while (true) {
    const { data, error } = await db
      .from('customers')
      .select('id, business_name, license_name, omma_license, city, is_active, assigned_sales_id')
      .order('business_name')
      .range(from, from + batchSize - 1)

    if (error) {
      console.error('[orders] getOrderCustomers error:', error)
      return { error: 'Failed to load customers' }
    }

    if (!data || data.length === 0) break
    allCustomers.push(...data)
    if (data.length < batchSize) break
    from += batchSize
  }

  return { data: allCustomers }
}

// ---------------------------------------------------------------------------
// Read — customer_pricing for a given customer
// ---------------------------------------------------------------------------

export async function getOrderCustomerPricing(customerId: string): Promise<
  | { data: CustomerPricingRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('customer_pricing')
    .select('sku_id, product_type_id, price_per_unit')
    .eq('customer_id', customerId)

  if (error) {
    console.error('[orders] getOrderCustomerPricing error:', error)
    return { error: 'Failed to load customer pricing' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Read — commissions for the summary cards
// ---------------------------------------------------------------------------

export async function getOrderCommissions(): Promise<
  | { data: CommissionRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...VIEW_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('commissions')
    .select('order_id, commission_amount, status')

  if (error) {
    console.error('[orders] getOrderCommissions error:', error)
    return { error: 'Failed to load commissions' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Create — new order + items
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  customer_id: string
  order_notes?: string | null
  order_date: string
  requested_delivery_date: string
  // No total_price: the net total is always recomputed server-side from the
  // line items and the deductions below — a client total is never trusted.
  items: NewOrderItemInput[]
  payment_terms?: boolean
  terms_payment_date?: string | null
  discount?: DeductionInput | null
  credit?: DeductionInput | null
}

export async function createOrder(input: CreateOrderInput): Promise<
  | { error?: never }
  | { error: string }
> {
  const auth = await requireRole([...CREATE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.customer_id) return { error: 'Customer is required' }
  if (!input.items || input.items.length === 0) return { error: 'At least one order item is required' }
  if (!input.requested_delivery_date) return { error: 'Requested delivery date is required' }
  if (input.payment_terms && !input.terms_payment_date) return { error: 'Payment expected date is required for terms orders' }

  const db = await createServiceClient()

  // SPRO-151: nothing unorderable gets past here — checked before any write, so
  // a rejected order leaves no orders row and no order_items rows behind.
  const available = await assertSkusAvailable(db, input.items)
  if (!available.ok) return { error: available.error }

  // SPRO-148: derive every line amount from the skus table, then validate the
  // deductions against that server subtotal — both before any write.
  const priced = await priceLineItems(db, input.items)
  if (!priced.ok) return { error: priced.error }

  const deductions = validateOrderDeductions({
    subtotal: priced.subtotal,
    discount: input.discount,
    credit: input.credit,
  })
  if (!deductions.ok) return { error: deductions.error }

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      agent_id: auth.session.userId,
      customer_id: input.customer_id,
      order_notes: input.order_notes ?? null,
      order_date: input.order_date,
      requested_delivery_date: input.requested_delivery_date,
      status: 'pending',
      total_price: deductions.totals.netTotal,
      ...deductions.fields,
      payment_terms: input.payment_terms ?? false,
      terms_payment_date: (input.payment_terms && input.terms_payment_date) ? input.terms_payment_date : null,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('[orders] createOrder error:', orderError)
    return { error: 'Failed to create order' }
  }

  const itemsToInsert = priced.items.map(item => ({
    order_id: order.id,
    sku_id: item.sku_id,
    quantity: item.cases,      // store cases, not units
    unit_price: item.unit_price,
    line_total: item.line_total,
  }))

  const { error: itemsError } = await db.from('order_items').insert(itemsToInsert)

  if (itemsError) {
    console.error('[orders] createOrder items error:', itemsError)
    // Best-effort rollback of the orphaned order
    await db.from('orders').delete().eq('id', order.id)
    return { error: 'Failed to create order items' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — quick status change (approve/pack/deliver/cancel)
// ---------------------------------------------------------------------------

export async function updateOrderStatus(
  orderId: string,
  newStatus: string
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...APPROVE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const updateData: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
    last_edited_by: auth.session.userId,
    last_edited_at: new Date().toISOString(),
  }

  if (newStatus === 'confirmed') {
    updateData.approved_by = auth.session.userId
    updateData.approved_at = new Date().toISOString()
  }

  if (newStatus === 'delivered') {
    updateData.delivered_at = new Date().toISOString()
  } else {
    updateData.delivered_at = null
  }

  const db = await createServiceClient()

  const { error } = await db.from('orders').update(updateData).eq('id', orderId)

  if (error) {
    console.error('[orders] updateOrderStatus error:', error)
    return { error: 'Failed to update order status' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — full order save (sheet edit form)
// ---------------------------------------------------------------------------

export interface SaveOrderInput {
  status: OrderStatus
  order_notes: string
  requested_delivery_date: string | null
  delivered_at_override: string        // '' = no change; 'YYYY-MM-DD' overwrites delivered_at
  // Current delivered_at from the DB (to decide auto-set logic)
  existing_delivered_at?: string | null
  items: UpdateOrderItemInput[]
  payment_terms: boolean
  terms_payment_date: string | null
  discount?: DeductionInput | null
  credit?: DeductionInput | null
}

export async function saveOrder(
  orderId: string,
  input: SaveOrderInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...EDIT_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  // Server-side total guard: re-derive every ACTIVE line amount from the skus
  // table, then net off the validated deductions — neither a client line
  // amount nor a client total is ever trusted (SPRO-148).
  const priced = await priceLineItems(db, input.items)
  if (!priced.ok) return { error: priced.error }

  const deductions = validateOrderDeductions({
    subtotal: priced.subtotal,
    discount: input.discount,
    credit: input.credit,
  })
  if (!deductions.ok) return { error: deductions.error }

  // Compute delivered_at — use T12:00:00Z (midday UTC) for date strings so
  // Central-time dates don't slip a day backward.
  let deliveredAt: string | null = null
  if (input.delivered_at_override) {
    deliveredAt = new Date(input.delivered_at_override + 'T12:00:00Z').toISOString()
  } else if (input.status === 'delivered' && !input.existing_delivered_at) {
    deliveredAt = new Date().toISOString()
  } else if (input.status !== 'delivered') {
    deliveredAt = null
  }
  // If status=delivered and existing delivered_at was already set and no new date provided,
  // keep the existing value — do not overwrite (omit delivered_at from update payload)
  const keepExistingDeliveredAt =
    input.status === 'delivered' &&
    !!input.existing_delivered_at &&
    !input.delivered_at_override

  if (input.payment_terms && !input.terms_payment_date) return { error: 'Payment expected date is required for terms orders' }

  const updatePayload: Record<string, unknown> = {
    status: input.status,
    order_notes: input.order_notes,
    requested_delivery_date: input.requested_delivery_date || null,
    total_price: deductions.totals.netTotal,
    ...deductions.fields,
    last_edited_by: auth.session.userId,
    last_edited_at: new Date().toISOString(),
    payment_terms: input.payment_terms,
    terms_payment_date: input.payment_terms ? (input.terms_payment_date || null) : null,
  }

  if (!keepExistingDeliveredAt) {
    updatePayload.delivered_at = deliveredAt
  }

  const { error: orderError } = await db
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)

  if (orderError) {
    console.error('[orders] saveOrder order error:', orderError)
    return { error: 'Failed to save order' }
  }

  // Handle order item mutations — amounts come from priceLineItems, not the client
  const items = priced.items

  // Delete removed items
  const deletedItems = items.filter(item => item._deleted && item.id)
  for (const item of deletedItems) {
    const { error } = await db.from('order_items').delete().eq('id', item.id!)
    if (error) {
      console.error('[orders] saveOrder delete item error:', error)
      return { error: 'Failed to remove order item' }
    }
  }

  // Update existing items
  const existingItems = items.filter(item => item.id && !item._deleted)
  for (const item of existingItems) {
    const { error } = await db
      .from('order_items')
      .update({
        sku_id: item.sku_id,
        quantity: item.cases,
        unit_price: item.unit_price ?? null,
        line_total: item.line_total,
      })
      .eq('id', item.id!)
    if (error) {
      console.error('[orders] saveOrder update item error:', error)
      return { error: 'Failed to update order item' }
    }
  }

  // Insert new items
  const newItems = items.filter(item => !item.id && !item._deleted)
  if (newItems.length > 0) {
    const { error } = await db.from('order_items').insert(
      newItems.map(item => ({
        order_id: orderId,
        sku_id: item.sku_id,
        quantity: item.cases,
        unit_price: item.unit_price ?? null,
        line_total: item.line_total,
      }))
    )
    if (error) {
      console.error('[orders] saveOrder insert items error:', error)
      return { error: 'Failed to add order items' }
    }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — order sheet (create or update)
// ---------------------------------------------------------------------------

export interface UpsertOrderSheetInput {
  customer_id: string
  order_notes?: string | null
  requested_delivery_date: string
  delivered_at?: string | null   // date string 'YYYY-MM-DD' or empty
  // No total_price: the net total is always recomputed server-side from the
  // line items and the deductions below — a client total is never trusted.
  items: NewOrderItemInput[]
  payment_terms?: boolean
  terms_payment_date?: string | null
  discount?: DeductionInput | null
  credit?: DeductionInput | null
}

export async function createOrderFromSheet(input: UpsertOrderSheetInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...CREATE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.customer_id) return { error: 'Customer is required' }
  if (!input.items || input.items.length === 0) return { error: 'At least one order item is required' }
  if (!input.requested_delivery_date) return { error: 'Requested delivery date is required' }
  if (input.payment_terms && !input.terms_payment_date) return { error: 'Payment expected date is required for terms orders' }

  const db = await createServiceClient()

  // SPRO-151: same availability gate as createOrder — the order sheet is the
  // other way a brand-new order gets created.
  const available = await assertSkusAvailable(db, input.items)
  if (!available.ok) return { error: available.error }

  // SPRO-148: derive every line amount from the skus table, then validate the
  // deductions against that server subtotal — both before any write.
  const priced = await priceLineItems(db, input.items)
  if (!priced.ok) return { error: priced.error }

  const deductions = validateOrderDeductions({
    subtotal: priced.subtotal,
    discount: input.discount,
    credit: input.credit,
  })
  if (!deductions.ok) return { error: deductions.error }

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      customer_id: input.customer_id,
      agent_id: auth.session.userId,
      order_notes: input.order_notes ?? null,
      requested_delivery_date: input.requested_delivery_date,
      status: 'pending',
      total_price: deductions.totals.netTotal,
      ...deductions.fields,
      order_date: new Date().toISOString().split('T')[0],
      payment_terms: input.payment_terms ?? false,
      terms_payment_date: (input.payment_terms && input.terms_payment_date) ? input.terms_payment_date : null,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('[orders] createOrderFromSheet error:', orderError)
    return { error: 'Failed to create order' }
  }

  const itemsToInsert = priced.items.map(item => ({
    order_id: order.id,
    sku_id: item.sku_id,
    quantity: item.cases,
    unit_price: item.unit_price,
    line_total: item.line_total,
  }))

  const { error: itemsError } = await db.from('order_items').insert(itemsToInsert)

  if (itemsError) {
    console.error('[orders] createOrderFromSheet items error:', itemsError)
    await db.from('orders').delete().eq('id', order.id)
    return { error: 'Failed to create order items' }
  }

  return {}
}

export async function updateOrderFromSheet(
  orderId: string,
  input: UpsertOrderSheetInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...EDIT_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (input.payment_terms && !input.terms_payment_date) return { error: 'Payment expected date is required for terms orders' }

  const db = await createServiceClient()

  // SPRO-148: derive every line amount from the skus table, then validate the
  // deductions against that server subtotal — both before any write.
  const priced = await priceLineItems(db, input.items)
  if (!priced.ok) return { error: priced.error }

  const deductions = validateOrderDeductions({
    subtotal: priced.subtotal,
    discount: input.discount,
    credit: input.credit,
  })
  if (!deductions.ok) return { error: deductions.error }

  const { error: orderError } = await db
    .from('orders')
    .update({
      customer_id: input.customer_id,
      order_notes: input.order_notes ?? null,
      requested_delivery_date: input.requested_delivery_date,
      delivered_at: input.delivered_at || null,
      total_price: deductions.totals.netTotal,
      ...deductions.fields,
      updated_at: new Date().toISOString(),
      last_edited_by: auth.session.userId,
      last_edited_at: new Date().toISOString(),
      payment_terms: input.payment_terms ?? false,
      terms_payment_date: (input.payment_terms && input.terms_payment_date) ? input.terms_payment_date : null,
    })
    .eq('id', orderId)

  if (orderError) {
    console.error('[orders] updateOrderFromSheet error:', orderError)
    return { error: 'Failed to update order' }
  }

  // Replace all items (delete then re-insert)
  const { error: deleteError } = await db
    .from('order_items')
    .delete()
    .eq('order_id', orderId)

  if (deleteError) {
    console.error('[orders] updateOrderFromSheet delete items error:', deleteError)
    return { error: 'Failed to update order items' }
  }

  const itemsToInsert = priced.items.map(item => ({
    order_id: orderId,
    sku_id: item.sku_id,
    quantity: item.cases,
    unit_price: item.unit_price,
    line_total: item.line_total,
  }))

  const { error: itemsError } = await db.from('order_items').insert(itemsToInsert)

  if (itemsError) {
    console.error('[orders] updateOrderFromSheet items error:', itemsError)
    return { error: 'Failed to update order items' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — mark a terms order as paid (the ONLY writer of terms_paid_at)
// ---------------------------------------------------------------------------

/**
 * Records payment receipt for a terms order.
 * Sets terms_paid_at, which fires Path B of the commission trigger.
 * Gate: EDIT_ROLES (per Stokely amendment — not APPROVE gate).
 */
export async function markTermsOrderPaid(
  orderId: string,
  paidDate: string
): Promise<{ error?: string }> {
  const auth = await requireRole([...EDIT_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data: order, error: fe } = await db
    .from('orders')
    .select('id, payment_terms, status, terms_paid_at')
    .eq('id', orderId)
    .single()

  if (fe || !order) return { error: 'Order not found' }
  if (!order.payment_terms) return { error: 'Order is not a terms order' }
  if (order.status !== 'delivered') return { error: 'Order must be delivered before marking payment received' }
  if (order.terms_paid_at) return { error: 'Payment already recorded for this order' }

  const paidAt = new Date(paidDate + 'T12:00:00Z').toISOString()   // midday UTC, no day-slip

  const { error } = await db
    .from('orders')
    .update({
      terms_paid_at: paidAt,
      last_edited_by: auth.session.userId,
      last_edited_at: new Date().toISOString(),
    })
    .eq('id', orderId)

  if (error) {
    console.error('[orders] markTermsOrderPaid:', error)
    return { error: 'Failed to record payment' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Delete — order (+ items via CASCADE or explicit delete)
// ---------------------------------------------------------------------------

export async function deleteOrder(orderId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...DELETE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  // Delete order — DB CASCADE handles order_items, packaging_task_sources, inventory_log
  const { error } = await db.from('orders').delete().eq('id', orderId)

  if (error) {
    console.error('[orders] deleteOrder error:', error)
    return { error: 'Failed to delete order' }
  }

  return {}
}
