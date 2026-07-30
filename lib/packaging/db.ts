/**
 * Supabase Database Layer for Packaging Dashboard
 *
 * Adapted for cake-app using server-side Supabase client
 */

import { createServiceClient } from '@/lib/supabase/server';
import {
  SKU,
  InventoryMap, InventoryLevels,
  Order, OrderStatus, OrderLineItem,
  Container, ContainerSize, ContainerStatus
} from './types';

// Cache SKU code -> UUID mapping (reloaded per request in server context)
let skuCodeToId: Map<string, string> | null = null;
let skuIdToCode: Map<string, string> | null = null;

// Load SKU mappings from database
async function loadSkuMappings(): Promise<void> {
  if (skuCodeToId !== null) return;

  const supabase = await createServiceClient();
  // Only load active SKUs — staged/discontinued must not appear in packaging boards
  const { data, error } = await supabase
    .from('skus')
    .select('id, code')
    .eq('status', 'active');

  if (error) throw new Error(`Failed to load SKUs: ${error.message}`);

  skuCodeToId = new Map();
  skuIdToCode = new Map();

  for (const sku of data || []) {
    skuCodeToId.set(sku.code, sku.id);
    skuIdToCode.set(sku.id, sku.code);
  }
}

// Get SKU UUID from code
async function getSkuId(code: SKU): Promise<string> {
  await loadSkuMappings();
  const id = skuCodeToId!.get(code);
  if (!id) throw new Error(`Unknown SKU code: ${code}`);
  return id;
}

// Get SKU code from UUID
async function getSkuCode(id: string): Promise<SKU> {
  await loadSkuMappings();
  const code = skuIdToCode!.get(id);
  if (!code) throw new Error(`Unknown SKU ID: ${id}`);
  return code as SKU;
}

// ============================================
// INVENTORY FUNCTIONS
// ============================================

// Read all inventory levels
export async function readInventory(): Promise<InventoryMap> {
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('inventory')
    .select('sku_id, cased, filled, staged');

  if (error) throw new Error(`Failed to read inventory: ${error.message}`);

  const inventory: InventoryMap = {};

  // Initialize all known SKUs with zeros
  for (const code of skuCodeToId!.keys()) {
    inventory[code] = { cased: 0, filled: 0, staged: 0 };
  }

  // Fill in actual values
  for (const row of data || []) {
    const code = skuIdToCode!.get(row.sku_id);
    if (code) {
      inventory[code] = {
        cased: row.cased,
        filled: row.filled,
        staged: row.staged,
      };
    }
  }

  return inventory;
}

// Read inventory for a single SKU
export async function readSKUInventory(sku: SKU): Promise<InventoryLevels> {
  const skuId = await getSkuId(sku);

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('inventory')
    .select('cased, filled, staged')
    .eq('sku_id', skuId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { cased: 0, filled: 0, staged: 0 };
    }
    throw new Error(`Failed to read SKU inventory: ${error.message}`);
  }

  return {
    cased: data.cased,
    filled: data.filled,
    staged: data.staged,
  };
}

// Update a single inventory cell
export async function updateInventoryCell(
  field: 'CASED' | 'STAGED' | 'FILLED',
  sku: SKU,
  value: number
): Promise<void> {
  const skuId = await getSkuId(sku);
  const fieldName = field.toLowerCase() as 'cased' | 'staged' | 'filled';

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('inventory')
    .update({ [fieldName]: value })
    .eq('sku_id', skuId);

  if (error) throw new Error(`Failed to update inventory: ${error.message}`);
}

// Update inventory with logging
async function updateInventoryWithLog(
  skuId: string,
  field: 'cased' | 'filled' | 'staged',
  oldValue: number,
  newValue: number,
  reason: string,
  taskId?: string,
  orderId?: string,
  containerId?: string
): Promise<void> {
  const supabase = await createServiceClient();

  // Update inventory
  const { error: updateError } = await supabase
    .from('inventory')
    .update({ [field]: newValue })
    .eq('sku_id', skuId);

  if (updateError) throw new Error(`Failed to update inventory: ${updateError.message}`);

  // Log the change
  const { error: logError } = await supabase
    .from('inventory_log')
    .insert({
      sku_id: skuId,
      field,
      old_value: oldValue,
      new_value: newValue,
      reason,
      task_id: taskId,
      order_id: orderId,
      container_id: containerId,
    });

  if (logError) {
    console.error('Failed to log inventory change:', logError.message);
  }
}

// Complete Step 1: Weigh & Fill (STAGED -> FILLED)
export async function completeWeighAndFill(
  sku: SKU,
  quantity: number,
  currentInventory: InventoryLevels
): Promise<InventoryLevels> {
  const skuId = await getSkuId(sku);

  const newStaged = Math.max(0, currentInventory.staged - quantity);
  const newFilled = currentInventory.filled + quantity;

  await Promise.all([
    updateInventoryWithLog(skuId, 'staged', currentInventory.staged, newStaged, 'fill_complete'),
    updateInventoryWithLog(skuId, 'filled', currentInventory.filled, newFilled, 'fill_complete'),
  ]);

  return {
    cased: currentInventory.cased,
    staged: newStaged,
    filled: newFilled,
  };
}

// Complete Step 2: Seal & Case (FILLED -> CASED)
export async function completeSealAndCase(
  sku: SKU,
  quantity: number,
  currentInventory: InventoryLevels
): Promise<InventoryLevels> {
  const skuId = await getSkuId(sku);

  const newFilled = Math.max(0, currentInventory.filled - quantity);
  const newCased = currentInventory.cased + quantity;

  await Promise.all([
    updateInventoryWithLog(skuId, 'filled', currentInventory.filled, newFilled, 'case_complete'),
    updateInventoryWithLog(skuId, 'cased', currentInventory.cased, newCased, 'case_complete'),
  ]);

  return {
    cased: newCased,
    staged: currentInventory.staged,
    filled: newFilled,
  };
}

// ============================================
// ORDERS FUNCTIONS
// ============================================

export async function readOrders(): Promise<Order[]> {
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data: ordersData, error: ordersError } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      customer_id,
      status,
      requested_delivery_date,
      actual_delivery_date,
      legacy_row_number,
      customers (
        business_name
      ),
      order_items (
        sku_id,
        quantity
      )
    `)
    .in('status', ['pending', 'confirmed', 'packed'])
    .order('requested_delivery_date', { ascending: true });

  if (ordersError) throw new Error(`Failed to read orders: ${ordersError.message}`);

  const orders: Order[] = [];

  for (const order of ordersData || []) {
    const lineItems: OrderLineItem[] = [];

    for (const item of order.order_items || []) {
      const skuCode = skuIdToCode!.get(item.sku_id);
      if (skuCode) {
        // quantity is CASES
        lineItems.push({
          sku: skuCode as SKU,
          quantity: item.quantity,
        });
      }
    }

    const statusMap: Record<string, OrderStatus> = {
      pending: 'Pending',
      confirmed: 'Confirmed',
      packed: 'Packed',
      delivered: 'Delivered',
    };

    // customers may be an array (from join) or single object
    const customer = Array.isArray(order.customers) ? order.customers[0] : order.customers;
    orders.push({
      id: order.id,
      customerName: (customer as { business_name: string } | null)?.business_name || 'Unknown',
      status: statusMap[order.status] || '',
      deliveryDate: order.requested_delivery_date || null,
      lastDeliveryDate: order.actual_delivery_date || '',
      orderBackup: null,
      lineItems,
      rowNumber: order.legacy_row_number || 0,
    });
  }

  return orders;
}

// ============================================
// CONTAINERS (STAGING) FUNCTIONS
// ============================================

export async function readStagingContainers(): Promise<Container[]> {
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('containers')
    .select('id, sku_id, size, status, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to read staging containers: ${error.message}`);
  }

  const containers: Container[] = [];

  for (const row of data || []) {
    const skuCode = skuIdToCode!.get(row.sku_id);
    if (!skuCode) continue;

    containers.push({
      id: row.id,
      sku: skuCode as SKU,
      size: row.size as ContainerSize,
      dateAdded: row.created_at ? new Date(row.created_at) : new Date(),
      status: row.status as ContainerStatus,
      rowNumber: 0,
    });
  }

  return containers;
}

export async function addContainer(
  sku: SKU,
  size: ContainerSize
): Promise<Container> {
  const skuId = await getSkuId(sku);

  const supabase = await createServiceClient();
  const { data: container, error: insertError } = await supabase
    .from('containers')
    .insert({
      sku_id: skuId,
      size,
      status: 'AVAILABLE',
    })
    .select()
    .single();

  if (insertError) throw new Error(`Failed to add container: ${insertError.message}`);

  const currentInventory = await readSKUInventory(sku);
  const newStaged = currentInventory.staged + size;

  await updateInventoryWithLog(
    skuId,
    'staged',
    currentInventory.staged,
    newStaged,
    'container_added',
    undefined,
    undefined,
    container.id
  );

  return {
    id: container.id,
    sku,
    size,
    dateAdded: container.created_at ? new Date(container.created_at) : new Date(),
    status: 'AVAILABLE',
    rowNumber: 0,
  };
}

export async function removeContainer(containerId: string): Promise<void> {
  const supabase = await createServiceClient();

  const { data: container, error: fetchError } = await supabase
    .from('containers')
    .select('sku_id, size, status')
    .eq('id', containerId)
    .single();

  if (fetchError) throw new Error(`Container not found: ${fetchError.message}`);

  const { error: deleteError } = await supabase
    .from('containers')
    .delete()
    .eq('id', containerId);

  if (deleteError) throw new Error(`Failed to remove container: ${deleteError.message}`);

  if (container.status === 'AVAILABLE') {
    const skuCode = await getSkuCode(container.sku_id);
    const currentInventory = await readSKUInventory(skuCode);
    const newStaged = Math.max(0, currentInventory.staged - container.size);

    await updateInventoryWithLog(
      container.sku_id,
      'staged',
      currentInventory.staged,
      newStaged,
      'container_removed',
      undefined,
      undefined,
      containerId
    );
  }
}

// ============================================
// ORDER STATUS PROCESSING
// ============================================

async function deductFromCased(orderId: string): Promise<void> {
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data: items, error } = await supabase
    .from('order_items')
    .select('sku_id, quantity')
    .eq('order_id', orderId);

  if (error || !items) {
    console.error('Error fetching order items for deduction:', error);
    return;
  }

  for (const item of items) {
    const skuCode = skuIdToCode!.get(item.sku_id);
    if (!skuCode) continue;

    const currentInventory = await readSKUInventory(skuCode as SKU);
    const newCased = Math.max(0, currentInventory.cased - item.quantity);

    await updateInventoryWithLog(
      item.sku_id,
      'cased',
      currentInventory.cased,
      newCased,
      'order_packed',
      undefined,
      orderId
    );
  }
}

async function restoreToCased(orderId: string): Promise<void> {
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data: items, error } = await supabase
    .from('order_items')
    .select('sku_id, quantity')
    .eq('order_id', orderId);

  if (error || !items) {
    console.error('Error fetching order items for restoration:', error);
    return;
  }

  for (const item of items) {
    const skuCode = skuIdToCode!.get(item.sku_id);
    if (!skuCode) continue;

    const currentInventory = await readSKUInventory(skuCode as SKU);
    const newCased = currentInventory.cased + item.quantity;

    await updateInventoryWithLog(
      item.sku_id,
      'cased',
      currentInventory.cased,
      newCased,
      'order_unpacked',
      undefined,
      orderId
    );
  }
}

export async function processOrderStatusChanges(): Promise<{
  packedProcessed: number;
  deliveredProcessed: number;
  reversedPacked: number;
}> {
  let packedProcessed = 0;
  let deliveredProcessed = 0;
  let reversedPacked = 0;

  const supabase = await createServiceClient();
  const { data: orders, error } = await supabase
    .from('orders')
    .select(`
      id,
      status,
      packed_at,
      delivered_at,
      order_items (sku_id, quantity)
    `)
    .in('status', ['pending', 'confirmed', 'packed', 'delivered']);

  if (error || !orders) {
    console.error('Error fetching orders for status processing:', error);
    return { packedProcessed, deliveredProcessed, reversedPacked };
  }

  for (const order of orders) {
    const hasItems = order.order_items && order.order_items.length > 0;

    if (order.status === 'packed' && !order.packed_at && hasItems) {
      await deductFromCased(order.id);

      await supabase
        .from('orders')
        .update({ packed_at: new Date().toISOString() })
        .eq('id', order.id);

      packedProcessed++;
    } else if (order.status === 'delivered' && !order.delivered_at && hasItems) {
      if (!order.packed_at) {
        await deductFromCased(order.id);
      }

      await supabase
        .from('orders')
        .update({ delivered_at: new Date().toISOString() })
        .eq('id', order.id);

      deliveredProcessed++;
    } else if (
      (order.status === 'pending' || order.status === 'confirmed') &&
      order.packed_at &&
      hasItems
    ) {
      await restoreToCased(order.id);

      await supabase
        .from('orders')
        .update({ packed_at: null })
        .eq('id', order.id);

      reversedPacked++;
    }
  }

  return { packedProcessed, deliveredProcessed, reversedPacked };
}

// ============================================
// TASK NOTES FUNCTIONS
// ============================================

export async function readTaskNotes(): Promise<Record<string, string>> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('task_notes')
    .select('task_key, note');

  if (error) {
    console.error('Error reading task notes:', error);
    return {};
  }

  const notes: Record<string, string> = {};
  for (const row of data || []) {
    notes[row.task_key] = row.note;
  }

  return notes;
}

export async function saveTaskNote(taskId: string, note: string): Promise<void> {
  const supabase = await createServiceClient();

  if (note.trim() === '') {
    const { error } = await supabase
      .from('task_notes')
      .delete()
      .eq('task_key', taskId);

    if (error) {
      console.error('Error deleting task note:', error);
    }
    return;
  }

  const { error } = await supabase
    .from('task_notes')
    .upsert(
      { task_key: taskId, note },
      { onConflict: 'task_key' }
    );

  if (error) {
    console.error('Error saving task note:', error);
    throw error;
  }
}

// ============================================
// MANUAL INVENTORY ADJUSTMENT
// ============================================

export async function updateInventoryLevels(
  sku: SKU,
  updates: { cased?: number; filled?: number; staged?: number },
  reason: string = 'manual_adjustment'
): Promise<InventoryLevels> {
  const skuId = await getSkuId(sku);
  const currentInventory = await readSKUInventory(sku);

  const promises: Promise<void>[] = [];

  if (updates.cased !== undefined && updates.cased !== currentInventory.cased) {
    promises.push(
      updateInventoryWithLog(skuId, 'cased', currentInventory.cased, updates.cased, reason)
    );
  }

  if (updates.filled !== undefined && updates.filled !== currentInventory.filled) {
    promises.push(
      updateInventoryWithLog(skuId, 'filled', currentInventory.filled, updates.filled, reason)
    );
  }

  if (updates.staged !== undefined && updates.staged !== currentInventory.staged) {
    promises.push(
      updateInventoryWithLog(skuId, 'staged', currentInventory.staged, updates.staged, reason)
    );
  }

  await Promise.all(promises);

  return {
    cased: updates.cased ?? currentInventory.cased,
    filled: updates.filled ?? currentInventory.filled,
    staged: updates.staged ?? currentInventory.staged,
  };
}

// ============================================
// TASK STATE PERSISTENCE
// ============================================

export interface TaskState {
  task_key: string;
  sku: string;
  task_type: string;
  current_column: string;
  quantity: number;
  completed_at: string | null;
}

export async function readTaskStates(): Promise<Record<string, TaskState>> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('packaging_task_state')
    .select('task_key, sku, task_type, current_column, quantity, completed_at');

  if (error) {
    console.error('Error reading task states:', error);
    return {};
  }

  const states: Record<string, TaskState> = {};

  for (const row of data || []) {
    if (row.current_column === 'DONE' && row.completed_at) {
      const completedDate = new Date(row.completed_at);
      completedDate.setHours(0, 0, 0, 0);
      if (completedDate < today) {
        continue;
      }
    }

    states[row.task_key] = {
      task_key: row.task_key,
      sku: row.sku,
      task_type: row.task_type,
      current_column: row.current_column,
      quantity: row.quantity,
      completed_at: row.completed_at,
    };
  }

  return states;
}

export async function saveTaskState(
  taskKey: string,
  sku: string,
  taskType: string,
  column: string,
  quantity: number
): Promise<void> {
  const completedAt = column === 'DONE' ? new Date().toISOString() : null;

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('packaging_task_state')
    .upsert(
      {
        task_key: taskKey,
        sku,
        task_type: taskType,
        current_column: column,
        quantity,
        completed_at: completedAt,
      },
      { onConflict: 'task_key' }
    );

  if (error) {
    console.error('Error saving task state:', error);
    throw error;
  }
}

export async function deleteTaskState(taskKey: string): Promise<void> {
  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('packaging_task_state')
    .delete()
    .eq('task_key', taskKey);

  if (error) {
    console.error('Error deleting task state:', error);
  }
}

export async function cleanupOldTaskStates(): Promise<number> {
  // Get start of today in local timezone, then convert to UTC for comparison
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayUTC = todayLocal.toISOString();

  const supabase = await createServiceClient();

  const { data, error } = await supabase
    .from('packaging_task_state')
    .delete()
    .eq('current_column', 'DONE')
    .lt('completed_at', todayUTC)
    .select();

  if (error) {
    console.error('Error cleaning up old task states:', error);
    return 0;
  }

  return data?.length || 0;
}

export { loadSkuMappings, getSkuId, getSkuCode };
