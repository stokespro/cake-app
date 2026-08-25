'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import type { InventoryLevel, PackagingTask, OrderWithItems } from '@/types/packaging'

// Roles that can access packaging actions — generous set so the shared TV
// (packaging, vault, standard) and management/admin are never locked out.
const PACKAGING_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard'] as const

// Get inventory levels for all SKUs
export async function getInventoryLevels(): Promise<{
  success: boolean
  inventory?: InventoryLevel[]
  error?: string
}> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  const { data, error } = await supabase
    .from('skus')
    .select(`
      id,
      code,
      name,
      inventory (
        cased,
        filled,
        staged
      )
    `)
    .eq('status', 'active')
    .order('code')

  if (error) {
    return { success: false, error: error.message }
  }

  const inventory: InventoryLevel[] = data.map(sku => ({
    sku_id: sku.id,
    sku_code: sku.code,
    sku_name: sku.name,
    cased: sku.inventory?.[0]?.cased ?? 0,
    filled: sku.inventory?.[0]?.filled ?? 0,
    staged: sku.inventory?.[0]?.staged ?? 0,
  }))

  return { success: true, inventory }
}

// Get current packaging tasks
export async function getPackagingTasks(): Promise<{
  success: boolean
  tasks?: PackagingTask[]
  error?: string
}> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  const { data, error } = await supabase
    .from('packaging_task_state')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, tasks: data as PackagingTask[] }
}

// Get confirmed orders for packaging view
export async function getConfirmedOrders(): Promise<{
  success: boolean
  orders?: OrderWithItems[]
  error?: string
}> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      status,
      requested_delivery_date,
      customer:customers(business_name),
      order_items (
        quantity,
        sku:skus(code)
      )
    `)
    .in('status', ['confirmed', 'pending'])
    .order('requested_delivery_date', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  const orders: OrderWithItems[] = data.map(order => ({
    id: order.id,
    order_number: order.order_number || '',
    customer_name: (order.customer as { business_name: string })?.business_name || 'Unknown',
    status: order.status,
    requested_delivery_date: order.requested_delivery_date,
    order_items: order.order_items.map((item: { quantity: number; sku: { code: string } | null }) => ({
      sku_code: item.sku?.code || '',
      quantity: item.quantity,
    })),
  }))

  return { success: true, orders }
}

// Advance a task (TO_FILL -> TO_CASE, or TO_CASE -> DONE)
export async function advanceTask(
  taskId: string,
  sku: string,
  quantity: number,
  fromColumn: 'TO_FILL' | 'TO_CASE'
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  // Get current inventory for this SKU
  const { data: skuData, error: skuError } = await supabase
    .from('skus')
    .select('id')
    .eq('code', sku)
    .single()

  if (skuError || !skuData) {
    return { success: false, error: 'SKU not found' }
  }

  const skuId = skuData.id

  // SPRO-131: a SKU with no inventory row holds nothing. Read it as zeros so
  // the insufficiency guards below produce an accurate message instead of a
  // misleading "Inventory not found".
  const { data: inventoryRow } = await supabase
    .from('inventory')
    .select('*')
    .eq('sku_id', skuId)
    .maybeSingle()

  const inventory = inventoryRow ?? { staged: 0, filled: 0, cased: 0 }

  if (fromColumn === 'TO_FILL') {
    // STAGED -> FILLED
    if (inventory.staged < quantity) {
      return { success: false, error: 'Insufficient staged inventory' }
    }

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        staged: inventory.staged - quantity,
        filled: inventory.filled + quantity,
      })
      .eq('sku_id', skuId)
      .select('sku_id')

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    // A decrement must never create a row, so this stays an UPDATE — but an
    // UPDATE matching nothing is not an error, so prove a row moved.
    if (!updated || updated.length === 0) {
      return { success: false, error: `Inventory update failed: no row for ${sku}` }
    }

    // Update task state to TO_CASE
    const { error: taskError } = await supabase
      .from('packaging_task_state')
      .update({
        current_column: 'TO_CASE',
        task_type: 'CASE',
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)

    if (taskError) {
      return { success: false, error: taskError.message }
    }
  } else if (fromColumn === 'TO_CASE') {
    // FILLED -> CASED
    if (inventory.filled < quantity) {
      return { success: false, error: 'Insufficient filled inventory' }
    }

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        filled: inventory.filled - quantity,
        cased: inventory.cased + quantity,
      })
      .eq('sku_id', skuId)
      .select('sku_id')

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    if (!updated || updated.length === 0) {
      return { success: false, error: `Inventory update failed: no row for ${sku}` }
    }

    // Update task state to DONE
    const { error: taskError } = await supabase
      .from('packaging_task_state')
      .update({
        current_column: 'DONE',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)

    if (taskError) {
      return { success: false, error: taskError.message }
    }
  }

  return { success: true }
}

// Revert a task (TO_CASE -> TO_FILL, or DONE -> TO_CASE)
export async function revertTask(
  taskId: string,
  sku: string,
  quantity: number,
  fromColumn: 'TO_CASE' | 'DONE'
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  // Get SKU ID
  const { data: skuData, error: skuError } = await supabase
    .from('skus')
    .select('id')
    .eq('code', sku)
    .single()

  if (skuError || !skuData) {
    return { success: false, error: 'SKU not found' }
  }

  const skuId = skuData.id

  // SPRO-131: read a missing row as zeros; the guards below then reject the
  // revert with a reason instead of a bare "Inventory not found".
  const { data: inventoryRow } = await supabase
    .from('inventory')
    .select('*')
    .eq('sku_id', skuId)
    .maybeSingle()

  const inventory = inventoryRow ?? { staged: 0, filled: 0, cased: 0 }

  if (fromColumn === 'TO_CASE') {
    // FILLED -> STAGED
    if (inventory.filled < quantity) {
      return { success: false, error: 'Insufficient filled inventory to revert' }
    }

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        filled: inventory.filled - quantity,
        staged: inventory.staged + quantity,
      })
      .eq('sku_id', skuId)
      .select('sku_id')

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    if (!updated || updated.length === 0) {
      return { success: false, error: `Inventory update failed: no row for ${sku}` }
    }

    // Update task state to TO_FILL
    const { error: taskError } = await supabase
      .from('packaging_task_state')
      .update({
        current_column: 'TO_FILL',
        task_type: 'FILL',
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)

    if (taskError) {
      return { success: false, error: taskError.message }
    }
  } else if (fromColumn === 'DONE') {
    // CASED -> FILLED
    if (inventory.cased < quantity) {
      return { success: false, error: 'Insufficient cased inventory to revert' }
    }

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        cased: inventory.cased - quantity,
        filled: inventory.filled + quantity,
      })
      .eq('sku_id', skuId)
      .select('sku_id')

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    if (!updated || updated.length === 0) {
      return { success: false, error: `Inventory update failed: no row for ${sku}` }
    }

    // Update task state to TO_CASE
    const { error: taskError } = await supabase
      .from('packaging_task_state')
      .update({
        current_column: 'TO_CASE',
        completed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)

    if (taskError) {
      return { success: false, error: taskError.message }
    }
  }

  return { success: true }
}

// Add staged inventory
export async function addStagedInventory(
  sku: string,
  quantity: number
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  // Get SKU ID
  const { data: skuData, error: skuError } = await supabase
    .from('skus')
    .select('id')
    .eq('code', sku)
    .single()

  if (skuError || !skuData) {
    return { success: false, error: 'SKU not found' }
  }

  // SPRO-131: a missing inventory row used to hard-fail here with "Inventory
  // not found". A SKU that has never been stocked simply holds 0 — treat it as
  // such and let the upsert below create the row.
  const { data: inventory } = await supabase
    .from('inventory')
    .select('staged')
    .eq('sku_id', skuData.id)
    .maybeSingle()

  const currentStaged = inventory?.staged ?? 0

  const { data: updated, error: updateError } = await supabase
    .from('inventory')
    .upsert(
      { sku_id: skuData.id, staged: currentStaged + quantity },
      { onConflict: 'sku_id' }
    )
    .select('sku_id')

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  if (!updated || updated.length === 0) {
    return { success: false, error: `Staging failed: no inventory row written for ${sku}` }
  }

  return { success: true }
}

// Update inventory levels directly (for manual adjustments)
export async function updateInventory(
  sku: string,
  updates: { cased?: number; filled?: number; staged?: number }
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  // Get SKU ID
  const { data: skuData, error: skuError } = await supabase
    .from('skus')
    .select('id')
    .eq('code', sku)
    .single()

  if (skuError || !skuData) {
    return { success: false, error: 'SKU not found' }
  }

  // Build update object with only provided fields
  const updateData: Record<string, number> = {}
  if (updates.cased !== undefined) updateData.cased = updates.cased
  if (updates.filled !== undefined) updateData.filled = updates.filled
  if (updates.staged !== undefined) updateData.staged = updates.staged

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: 'No updates provided' }
  }

  // SPRO-131: upsert so a SKU with no inventory row gets one instead of the
  // UPDATE silently matching nothing. This is the path behind the "Edit
  // inventory" dialog — it reported "Updated AS" for a write that never landed.
  const { data: updated, error: updateError } = await supabase
    .from('inventory')
    .upsert({ sku_id: skuData.id, ...updateData }, { onConflict: 'sku_id' })
    .select('sku_id')

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  if (!updated || updated.length === 0) {
    return { success: false, error: `Update failed: no inventory row written for ${sku}` }
  }

  // Log the adjustment
  await supabase.from('inventory_log').insert({
    sku_id: skuData.id,
    change_type: 'manual_adjustment',
    cased_change: updates.cased !== undefined ? updates.cased : null,
    filled_change: updates.filled !== undefined ? updates.filled : null,
    staged_change: updates.staged !== undefined ? updates.staged : null,
    notes: 'Manual adjustment via CRM',
  })

  return { success: true }
}

// Get demand summary (aggregate order quantities by SKU)
export async function getDemandSummary(): Promise<{
  success: boolean
  demand?: Record<string, { total: number; urgent: number; tomorrow: number }>
  error?: string
}> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const { data: orders, error } = await supabase
    .from('orders')
    .select(`
      requested_delivery_date,
      order_items (
        quantity,
        sku:skus(code)
      )
    `)
    .in('status', ['confirmed', 'pending'])

  if (error) {
    return { success: false, error: error.message }
  }

  const demand: Record<string, { total: number; urgent: number; tomorrow: number }> = {}

  orders.forEach(order => {
    const deliveryDate = order.requested_delivery_date
      ? new Date(order.requested_delivery_date + 'T00:00:00')
      : null

    const isUrgent = deliveryDate && deliveryDate <= today
    const isTomorrow = deliveryDate &&
      deliveryDate.toDateString() === tomorrow.toDateString()

    order.order_items.forEach((item: { quantity: number; sku: { code: string } | null }) => {
      const skuCode = item.sku?.code
      if (!skuCode) return

      if (!demand[skuCode]) {
        demand[skuCode] = { total: 0, urgent: 0, tomorrow: 0 }
      }

      demand[skuCode].total += item.quantity
      if (isUrgent) demand[skuCode].urgent += item.quantity
      if (isTomorrow) demand[skuCode].tomorrow += item.quantity
    })
  })

  return { success: true, demand }
}
