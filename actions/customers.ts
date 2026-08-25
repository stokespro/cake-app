'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'

// Roles that can view dispensaries — mirrors canViewSection('dispensaries') in lib/auth-context.tsx
const DISPENSARY_ROLES = ['sales', 'agent', 'management', 'admin'] as const

// Roles that can write/manage dispensaries
const MANAGE_ROLES = ['management', 'admin'] as const

// Roles that can create dispensaries (includes sales/agent who self-assign)
const CREATE_ROLES = ['sales', 'agent', 'management', 'admin'] as const

// Roles that can edit a dispensary's profile fields. Deliberately wider than
// MANAGE_ROLES: sales/agent own the customer relationship and have always been
// able to correct a profile. Gating this on MANAGE_ROLES silently blocked every
// sales user's save (SPRO-130). Field-level restrictions still apply below —
// commission_exempt remains admin-only.
const EDIT_PROFILE_ROLES = ['sales', 'agent', 'management', 'admin'] as const

// Postgres unique-violation. `customers` carries a UNIQUE INDEX on
// lower(business_name), so a rename onto an existing dispensary is rejected
// here rather than silently merging the two records.
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Write result for customer create/update. `field` lets the caller attach the
 * message to the offending input instead of only firing a toast.
 */
export type CustomerWriteResult =
  | { error?: never; field?: never }
  | { error: string; field?: 'business_name' }

function duplicateNameError(name: string): CustomerWriteResult {
  return {
    error: `A dispensary named "${name}" already exists. Business names must be unique — add a location or suffix to tell them apart (e.g. "${name} - Tulsa").`,
    field: 'business_name',
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerRecord {
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
  has_orders?: boolean | null
  order_count?: number | null
  last_order_date?: string | null
  first_order_date?: string | null
  last_communication_date?: string | null
  assigned_sales_id?: string | null
  assigned_sales?: { id: string; full_name: string } | null
  created_at: string
  updated_at?: string | null
}

export interface CustomerDetail {
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
  has_orders?: boolean | null
  order_count?: number | null
  last_order_date?: string | null
  first_order_date?: string | null
  last_communication_date?: string | null
  assigned_sales_id?: string | null
  assigned_sales?: { id: string; name: string } | null
  created_at: string
  updated_at?: string | null
  total_orders_count?: number | null
  total_communications_count?: number | null
  total_revenue?: number | null
}

export interface CustomerFilters {
  search?: string
  city?: string
  salesPersonId?: string
  hasOrders?: boolean
  startDate?: string
  endDate?: string
  status?: string
  page?: number
  pageSize?: number
}

export interface SalesUserRecord {
  id: string
  name: string
}

export interface ProfileRecord {
  id: string
  full_name: string
}

export interface InventoryAvailabilityRecord {
  strainName: string
  productTypeName: string
  available: number
}

// ---------------------------------------------------------------------------
// Read — list dispensaries (paginated, filtered)
// ---------------------------------------------------------------------------

export async function getCustomers(filters: CustomerFilters = {}): Promise<
  | { data: CustomerRecord[]; count: number; error?: never }
  | { data?: never; count?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const pageSize = filters.pageSize ?? 50
  const page = filters.page ?? 1

  let query = db
    .from('customers')
    .select('*, assigned_sales:profiles!customers_assigned_sales_id_fkey(id, full_name)', { count: 'exact' })

  if (filters.search) {
    const term = `%${filters.search}%`
    query = query.or(
      `business_name.ilike.${term},license_name.ilike.${term},address.ilike.${term},email.ilike.${term},omma_license.ilike.${term}`
    )
  }

  if (filters.city) {
    query = query.eq('city', filters.city)
  }

  if (filters.salesPersonId) {
    if (filters.salesPersonId === 'unassigned') {
      query = query.is('assigned_sales_id', null)
    } else {
      query = query.eq('assigned_sales_id', filters.salesPersonId)
    }
  }

  if (filters.status === 'active') {
    query = query.eq('is_active', true)
  } else if (filters.status === 'inactive') {
    query = query.eq('is_active', false)
  }

  if (filters.hasOrders) {
    query = query.eq('has_orders', true)
  }

  if (filters.startDate) {
    query = query.gte('last_order_date', filters.startDate)
  }
  if (filters.endDate) {
    query = query.lte('first_order_date', filters.endDate)
  }

  query = query.order('business_name')

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  query = query.range(from, to)

  const { data, error, count } = await query

  if (error) {
    console.error('[customers] getCustomers error:', error)
    return { error: 'Failed to load dispensaries' }
  }

  return { data: data ?? [], count: count ?? 0 }
}

// ---------------------------------------------------------------------------
// Read — fetch city list for filter dropdown
// ---------------------------------------------------------------------------

export async function getCustomerCities(): Promise<
  | { data: string[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const allCities: { city: string }[] = []
  let from = 0
  const batchSize = 1000

  while (true) {
    const { data, error } = await db
      .from('customers')
      .select('city')
      .not('city', 'is', null)
      .order('city')
      .range(from, from + batchSize - 1)

    if (error) {
      console.error('[customers] getCustomerCities error:', error)
      return { error: 'Failed to load cities' }
    }

    if (!data || data.length === 0) break
    allCities.push(...data)
    if (data.length < batchSize) break
    from += batchSize
  }

  const unique = [...new Set(allCities.map(d => d.city).filter(Boolean) as string[])]
  return { data: unique }
}

// ---------------------------------------------------------------------------
// Read — fetch sales people (profiles with sales/agent roles) for filter
// ---------------------------------------------------------------------------

export async function getSalesPeople(): Promise<
  | { data: ProfileRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('profiles')
    .select('id, full_name')
    .in('role', ['sales', 'agent', 'management', 'admin'])
    .order('full_name')

  if (error) {
    console.error('[customers] getSalesPeople error:', error)
    return { error: 'Failed to load sales people' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Read — single dispensary detail
// ---------------------------------------------------------------------------

export async function getCustomer(customerId: string): Promise<
  | { data: CustomerDetail; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('customers')
    .select('*, assigned_sales:users!customers_assigned_sales_id_fkey(id, name)')
    .eq('id', customerId)
    .single()

  if (error || !data) {
    console.error('[customers] getCustomer error:', error)
    return { error: 'Dispensary not found' }
  }

  return { data }
}

// ---------------------------------------------------------------------------
// Read — sales users for assignment dropdown on detail page
// ---------------------------------------------------------------------------

export async function getSalesUsers(): Promise<
  | { data: SalesUserRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('users')
    .select('id, name')
    .in('role', ['sales', 'management', 'admin'])
    .order('name')

  if (error) {
    console.error('[customers] getSalesUsers error:', error)
    return { error: 'Failed to load sales users' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Read — communications for a dispensary
// ---------------------------------------------------------------------------

export async function getCustomerCommunications(customerId: string): Promise<
  | { data: Record<string, unknown>[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('communications')
    .select(`
      id,
      interaction_date,
      contact_method,
      notes,
      follow_up_required,
      agent_id,
      agent:users!communications_agent_id_fkey(name)
    `)
    .eq('customer_id', customerId)
    .order('interaction_date', { ascending: false })
    .limit(10)

  if (error) {
    console.error('[customers] getCustomerCommunications error:', error)
    return { error: 'Failed to load communications' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Read — orders for a dispensary
// ---------------------------------------------------------------------------

export async function getCustomerOrders(customerId: string): Promise<
  | { data: Record<string, unknown>[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('orders')
    .select(`
      id,
      order_number,
      customer_id,
      agent_id,
      order_date,
      status,
      total_price,
      order_notes,
      requested_delivery_date,
      confirmed_delivery_date,
      created_at,
      updated_at,
      agent:users!orders_agent_id_fkey(name)
    `)
    .eq('customer_id', customerId)
    .order('order_date', { ascending: false })
    .limit(10)

  if (error) {
    console.error('[customers] getCustomerOrders error:', error)
    return { error: 'Failed to load orders' }
  }

  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Read — available inventory for "Text Availability" feature
// ---------------------------------------------------------------------------

export async function getAvailableInventory(): Promise<
  | { data: InventoryAvailabilityRecord[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const [skusResult, strainsResult, productTypesResult, inventoryResult, packagesResult, ordersResult] =
    await Promise.all([
      db.from('skus').select('id, code, name, strain_id, product_type_id, grams_per_unit, units_per_case').order('code'),
      db.from('strains').select('id, name'),
      db.from('product_types').select('id, name'),
      db.from('inventory').select('sku_id, cased, filled, staged'),
      db.from('packages').select('strain_id, type_id, current_weight, is_active').eq('is_active', true),
      db.from('orders').select('id, status, order_items(sku_id, quantity)').in('status', ['pending', 'confirmed', 'packed']),
    ])

  if (skusResult.error || strainsResult.error || productTypesResult.error ||
      inventoryResult.error || packagesResult.error || ordersResult.error) {
    console.error('[customers] getAvailableInventory error')
    return { error: 'Failed to fetch inventory data' }
  }

  const skus = skusResult.data ?? []
  const strains = strainsResult.data ?? []
  const productTypes = productTypesResult.data ?? []
  const inventory = inventoryResult.data ?? []
  const vaultPackages = packagesResult.data ?? []
  const orders = ordersResult.data ?? []

  // Calculate pending orders by SKU
  const pendingOrderItems = new Map<string, number>()
  for (const order of orders) {
    for (const item of (order.order_items as { sku_id: string; quantity: number }[]) ?? []) {
      const current = pendingOrderItems.get(item.sku_id) ?? 0
      pendingOrderItems.set(item.sku_id, current + item.quantity)
    }
  }

  // Vault grams by strain + product type
  const vaultByStrainAndType = new Map<string, number>()
  for (const pkg of vaultPackages) {
    const key = `${pkg.strain_id}-${pkg.type_id}`
    const current = vaultByStrainAndType.get(key) ?? 0
    vaultByStrainAndType.set(key, current + pkg.current_weight)
  }

  const strainMap = new Map(strains.map(s => [s.id, s.name]))
  const typeMap = new Map(productTypes.map(t => [t.id, t.name]))
  const inventoryMap = new Map(inventory.map(i => [i.sku_id, i]))

  const availabilityByStrainType = new Map<string, InventoryAvailabilityRecord>()

  for (const sku of skus) {
    const strainName = strainMap.get(sku.strain_id) ?? 'Unknown'
    const productTypeName = typeMap.get(sku.product_type_id) ?? 'Unknown'
    const inv = inventoryMap.get(sku.id)

    const vaultKey = `${sku.strain_id}-${sku.product_type_id}`
    const vaultGrams = vaultByStrainAndType.get(vaultKey) ?? 0

    const gramsPerCase =
      ((sku as { grams_per_unit?: number }).grams_per_unit ?? 0) *
      ((sku as { units_per_case?: number }).units_per_case ?? 0)
    const vaultCases = gramsPerCase > 0 ? Math.floor(vaultGrams / gramsPerCase) : 0

    const staged = inv?.staged ?? 0
    const filled = inv?.filled ?? 0
    const cased = inv?.cased ?? 0
    const pendingOrders = pendingOrderItems.get(sku.id) ?? 0

    const available = vaultCases + staged + filled + cased - pendingOrders

    if (available > 0) {
      const key = `${strainName}-${productTypeName}`
      const existing = availabilityByStrainType.get(key)
      if (existing) {
        existing.available += available
      } else {
        availabilityByStrainType.set(key, { strainName, productTypeName, available })
      }
    }
  }

  const data = Array.from(availabilityByStrainType.values()).sort((a, b) =>
    a.strainName.localeCompare(b.strainName)
  )

  return { data }
}

// ---------------------------------------------------------------------------
// Read — customer_pricing + skus/product_types for pricing section
// ---------------------------------------------------------------------------

export async function getCustomerPricing(customerId: string): Promise<
  | { data: Record<string, unknown>[]; error?: never }
  | { data?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('customer_pricing')
    .select(`
      *,
      sku:skus(id, name, code),
      product_type:product_types(id, name)
    `)
    .eq('customer_id', customerId)

  if (error) {
    console.error('[customers] getCustomerPricing error:', error)
    return { error: 'Failed to load pricing' }
  }

  return { data: data ?? [] }
}

export async function getPricingOptions(): Promise<
  | { products: Record<string, unknown>[]; productTypes: Record<string, unknown>[]; error?: never }
  | { products?: never; productTypes?: never; error: string }
> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const [productsResult, typesResult] = await Promise.all([
    db.from('products').select('id, item_name, code, product_type_id, product_type_name').order('item_name'),
    db.from('product_types').select('*').order('name'),
  ])

  if (productsResult.error) {
    console.error('[customers] getPricingOptions products error:', productsResult.error)
    return { error: 'Failed to load products' }
  }
  if (typesResult.error) {
    console.error('[customers] getPricingOptions types error:', typesResult.error)
    return { error: 'Failed to load product types' }
  }

  return { products: productsResult.data ?? [], productTypes: typesResult.data ?? [] }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateCustomerInput {
  business_name: string
  license_name?: string
  address?: string
  phone_number?: string
  email?: string
  omma_license?: string
  ob_license?: string
  assigned_sales_id?: string | null
}

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerWriteResult> {
  const auth = await requireRole([...CREATE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.business_name?.trim()) {
    return { error: 'Business name is required' }
  }

  const db = await createServiceClient()

  const businessName = input.business_name.trim()

  const { error } = await db.from('customers').insert({
    business_name: businessName,
    license_name: input.license_name?.trim() || null,
    address: input.address?.trim() || null,
    phone_number: input.phone_number?.trim() || null,
    email: input.email?.trim() || null,
    omma_license: input.omma_license?.trim() || null,
    ob_license: input.ob_license?.trim() || null,
    assigned_sales_id: input.assigned_sales_id ?? null,
  })

  if (error) {
    console.error('[customers] createCustomer error:', error)
    if (error.code === PG_UNIQUE_VIOLATION) {
      return duplicateNameError(businessName)
    }
    return { error: 'Failed to create dispensary' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — dispensary profile fields
// ---------------------------------------------------------------------------

export interface UpdateCustomerInput {
  business_name: string
  license_name?: string
  address?: string
  phone_number?: string
  email?: string
  omma_license?: string
  ob_license?: string
  is_active?: boolean
  commission_exempt?: boolean
}

export async function updateCustomer(
  customerId: string,
  input: UpdateCustomerInput
): Promise<CustomerWriteResult> {
  const auth = await requireRole([...EDIT_PROFILE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.business_name?.trim()) {
    return { error: 'Business name is required' }
  }

  const db = await createServiceClient()

  const businessName = input.business_name.trim()

  const updateData: Record<string, unknown> = {
    business_name: businessName,
    license_name: input.license_name?.trim() || null,
    address: input.address?.trim() || null,
    phone_number: input.phone_number?.trim() || null,
    email: input.email?.trim() || null,
    omma_license: input.omma_license?.trim() || null,
    ob_license: input.ob_license?.trim() || null,
    is_active: input.is_active,
    updated_at: new Date().toISOString(),
  }

  // Defense-in-depth: only admins may change commission_exempt, even though
  // this action is otherwise reachable by management. The UI switch only
  // renders for admins, but we guard here too in case of direct calls.
  if (input.commission_exempt !== undefined && auth.session.role === 'admin') {
    updateData.commission_exempt = input.commission_exempt
  }

  const { error } = await db
    .from('customers')
    .update(updateData)
    .eq('id', customerId)

  if (error) {
    console.error('[customers] updateCustomer error:', error)
    if (error.code === PG_UNIQUE_VIOLATION) {
      return duplicateNameError(businessName)
    }
    return { error: 'Failed to update dispensary' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — assign sales rep
// ---------------------------------------------------------------------------

export async function assignSalesRep(
  customerId: string,
  salesId: string | null
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('customers')
    .update({ assigned_sales_id: salesId })
    .eq('id', customerId)

  if (error) {
    console.error('[customers] assignSalesRep error:', error)
    return { error: 'Failed to update sales assignment' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — toggle active status
// ---------------------------------------------------------------------------

export async function setCustomerActiveStatus(
  customerId: string,
  isActive: boolean
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...DISPENSARY_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('customers')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', customerId)

  if (error) {
    console.error('[customers] setCustomerActiveStatus error:', error)
    return { error: 'Failed to update active status' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update — order status (from detail page)
// ---------------------------------------------------------------------------

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  userId: string
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...MANAGE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const updateData: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
    last_edited_by: userId,
    last_edited_at: new Date().toISOString(),
  }

  if (newStatus === 'confirmed') {
    updateData.approved_by = userId
    updateData.approved_at = new Date().toISOString()
  }

  if (newStatus === 'delivered') {
    updateData.delivered_at = new Date().toISOString()
  } else {
    updateData.delivered_at = null
  }

  const { error } = await db.from('orders').update(updateData).eq('id', orderId)

  if (error) {
    console.error('[customers] updateOrderStatus error:', error)
    return { error: 'Failed to update order status' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Delete — order (with items) from detail page
// ---------------------------------------------------------------------------

export async function deleteOrder(orderId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...MANAGE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error: itemsError } = await db.from('order_items').delete().eq('order_id', orderId)

  if (itemsError) {
    console.error('[customers] deleteOrder items error:', itemsError)
    return { error: 'Failed to delete order items' }
  }

  const { error: orderError } = await db.from('orders').delete().eq('id', orderId)

  if (orderError) {
    console.error('[customers] deleteOrder error:', orderError)
    return { error: 'Failed to delete order' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Upsert / Delete — customer_pricing
// ---------------------------------------------------------------------------

export interface UpsertCustomerPricingInput {
  customer_id: string
  sku_id?: string | null
  product_type_id?: string | null
  price_per_unit: number
  mode: 'item' | 'category'
}

export async function upsertCustomerPricing(
  input: UpsertCustomerPricingInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole([...MANAGE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (input.price_per_unit <= 0) {
    return { error: 'Price must be greater than zero' }
  }

  const db = await createServiceClient()

  const pricingData = {
    customer_id: input.customer_id,
    sku_id: input.mode === 'item' ? input.sku_id : null,
    product_type_id: input.mode === 'category' ? input.product_type_id : null,
    price_per_unit: input.price_per_unit,
  }

  const { error } = await db
    .from('customer_pricing')
    .upsert(pricingData, {
      onConflict: input.mode === 'item' ? 'customer_id,sku_id' : 'customer_id,product_type_id',
    })

  if (error) {
    console.error('[customers] upsertCustomerPricing error:', error)
    return { error: 'Failed to save pricing' }
  }

  return {}
}

export async function deleteCustomerPricing(pricingId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...MANAGE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db.from('customer_pricing').delete().eq('id', pricingId)

  if (error) {
    console.error('[customers] deleteCustomerPricing error:', error)
    return { error: 'Failed to remove pricing' }
  }

  return {}
}
