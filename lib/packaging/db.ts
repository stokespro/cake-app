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
  // Only load active SKUs — staged/discontinued must not appear in packaging boards.
  // .order('code') is the fix for SPRO-128: without it, Supabase returns rows in
  // arbitrary/unstable order, which is what made the inventory strip's card order
  // shuffle across restarts. Downstream (readInventory()'s Map, generateSKUStatus's
  // Object.keys()) all preserve insertion order, so this one .order() call is what
  // makes the whole pipeline deterministic.
  const { data, error } = await supabase
    .from('skus')
    .select('id, code')
    .eq('status', 'active')
    .order('code');

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
    // PGRST116 = no row. A SKU with no inventory row genuinely holds nothing,
    // so zeros are the right read. This fallback is only safe because the
    // write path upserts (SPRO-131) — when it was update-only, this quietly
    // handed callers a 0 to increment and then threw the result away.
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
  // SPRO-131: upsert, not update — see updateInventoryWithLog() below for why.
  const { data, error } = await supabase
    .from('inventory')
    .upsert({ sku_id: skuId, [fieldName]: value }, { onConflict: 'sku_id' })
    .select('sku_id');

  if (error) throw new Error(`Failed to update inventory: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`Failed to update inventory: no row written for SKU ${sku}`);
  }
}

// Update inventory with logging.
//
// SPRO-131: this was a bare `.update().eq('sku_id', skuId)`. A SKU with no
// `inventory` row — which is every SKU created since the original vault seed,
// because nothing has ever inserted one — made that UPDATE match zero rows,
// and Postgres does not treat a zero-row UPDATE as an error. Supabase returned
// `error: null`, the inventory_log row was written regardless, and the UI
// toasted success for a write that never happened. Aloha Sugar was staged
// three times and stayed at 0.
//
// The upsert is the fix: `sku_id` is the primary key (`inventory_pkey`) and
// cased/filled/staged are NOT NULL DEFAULT 0, so writing one field either
// inserts the row with the other two at 0, or updates just that field on the
// existing row. Concurrent partial upserts on the same missing row are safe —
// the first inserts, the rest take the ON CONFLICT DO UPDATE branch — which
// matters because updateInventoryLevels() and completeWeighAndFill() both fire
// several of these through Promise.all.
//
// The `.select()` is not decoration: it is what makes a zero-row write
// impossible to mistake for success ever again.
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
  const { data: updated, error: updateError } = await supabase
    .from('inventory')
    .upsert({ sku_id: skuId, [field]: newValue }, { onConflict: 'sku_id' })
    .select('sku_id');

  if (updateError) throw new Error(`Failed to update inventory: ${updateError.message}`);
  if (!updated || updated.length === 0) {
    throw new Error(`Failed to update inventory: no row written for sku_id ${skuId}`);
  }

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

// Raw shape returned by the single shared orders query. Includes every
// column needed by BOTH readOrders() (board display) and
// processOrderStatusChanges() (cased-inventory side effects), so the two
// callers in getDashboardData() can share one DB round-trip instead of
// querying `orders` twice per invocation.
export interface RawOrderRow {
  id: string;
  order_number: string | null;
  customer_id: string;
  status: string;
  requested_delivery_date: string | null;
  actual_delivery_date: string | null;
  legacy_row_number: number | null;
  packed_at: string | null;
  delivered_at: string | null;
  customers: { business_name: string } | { business_name: string }[] | null;
  order_items: { sku_id: string; quantity: number }[];
}

const ORDERS_SELECT = `
  id,
  order_number,
  customer_id,
  status,
  requested_delivery_date,
  actual_delivery_date,
  legacy_row_number,
  packed_at,
  delivered_at,
  customers (
    business_name
  ),
  order_items (
    sku_id,
    quantity
  )
`;

// Single source-of-truth read of `orders` (+ joined customers/order_items)
// covering every status the packaging dashboard cares about — both the
// board-visible statuses (pending/confirmed/packed) AND 'delivered' (needed
// by processOrderStatusChanges to detect fresh pending->delivered/packed
// transitions). Callers derive whatever subset/shape they need from this
// one result instead of re-querying `orders`.
export async function readOrdersRaw(): Promise<RawOrderRow[]> {
  // mapOrdersFromRaw() below depends on the sku_id -> code cache being
  // populated; load it here so callers can go straight from
  // readOrdersRaw() -> mapOrdersFromRaw() without a separate await.
  await loadSkuMappings();

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('orders')
    .select(ORDERS_SELECT)
    .in('status', ['pending', 'confirmed', 'packed', 'delivered'])
    .order('requested_delivery_date', { ascending: true });

  if (error) throw new Error(`Failed to read orders: ${error.message}`);

  return (data || []) as unknown as RawOrderRow[];
}

// Map raw order rows -> the packaging Order[] shape used by the allocation
// engine. Excludes 'delivered' orders (they no longer need packaging).
export function mapOrdersFromRaw(rawOrders: RawOrderRow[]): Order[] {
  const statusMap: Record<string, OrderStatus> = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    packed: 'Packed',
    delivered: 'Delivered',
  };

  const orders: Order[] = [];

  for (const order of rawOrders) {
    if (order.status === 'delivered') continue;

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

export async function readOrders(): Promise<Order[]> {
  await loadSkuMappings();
  const rawOrders = await readOrdersRaw();
  return mapOrdersFromRaw(rawOrders);
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

// Accepts an optional pre-fetched `orders` result (raw rows from
// readOrdersRaw()) so callers that already read `orders` in the same
// request — e.g. getDashboardData() — don't have to query it again here.
// If omitted, falls back to fetching it directly (preserves the previous
// standalone behavior for any other caller).
export async function processOrderStatusChanges(
  preFetchedOrders?: RawOrderRow[]
): Promise<{
  packedProcessed: number;
  deliveredProcessed: number;
  reversedPacked: number;
}> {
  let packedProcessed = 0;
  let deliveredProcessed = 0;
  let reversedPacked = 0;

  const supabase = await createServiceClient();

  let orders: Pick<RawOrderRow, 'id' | 'status' | 'packed_at' | 'delivered_at' | 'order_items'>[];
  if (preFetchedOrders) {
    orders = preFetchedOrders;
  } else {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id,
        status,
        packed_at,
        delivered_at,
        order_items (sku_id, quantity)
      `)
      .in('status', ['pending', 'confirmed', 'packed', 'delivered']);

    if (error || !data) {
      console.error('Error fetching orders for status processing:', error);
      return { packedProcessed, deliveredProcessed, reversedPacked };
    }
    orders = data as unknown as RawOrderRow[];
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
