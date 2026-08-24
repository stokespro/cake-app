import {
  SKU,
  InventoryMap,
  Order,
  Task, TaskType, TaskStatus, TaskSource, PriorityTier, KanbanColumn,
  SKUStatus, SKUFormat, InventoryCellState, Container
} from './types';
import { isTomorrow, isWithinDays, daysUntil } from './utils';

// Target stock level per SKU
const BACKFILL_TARGET = 8;

// Low stock threshold (partial container warning)
const LOW_STOCK_THRESHOLD = 4;

// ============================================
// FORMAT DERIVATION (SPRO-128)
// ============================================

// grams_per_unit comes back from Supabase as a numeric string (e.g. "3.50"),
// so compare tolerantly after Number() rather than with strict ===.
function isCloseTo(value: number, target: number, epsilon = 0.01): boolean {
  return Math.abs(value - target) < epsilon;
}

// Derive a SKU's packaging format from structured columns ONLY — never by
// string-parsing the free-form `code` column, which is unvalidated
// (components/products/product-sheet.tsx:164-186). Rules verified against
// live data:
//   product_type "Bites"                                     -> Bites
//   product_type "A Buds" + grams_per_unit 14                 -> Half
//   product_type "A Buds" + grams_per_unit 3.5 + units_per_case 8 -> Variety
//   product_type "A Buds" + grams_per_unit 3.5                -> Eighth
//   anything else                                              -> Other
export function deriveFormat(
  productTypeName: string | null | undefined,
  gramsPerUnit: number | string | null | undefined,
  unitsPerCase: number | string | null | undefined
): SKUFormat {
  const grams = Number(gramsPerUnit);
  const units = Number(unitsPerCase);
  const type = (productTypeName || '').trim();

  if (type === 'Bites') return 'Bites';

  if (type === 'A Buds') {
    if (isCloseTo(grams, 14)) return 'Half';
    if (isCloseTo(grams, 3.5) && units === 8) return 'Variety';
    if (isCloseTo(grams, 3.5)) return 'Eighth';
  }

  return 'Other';
}

// ============================================
// INVENTORY CELL STATE (SPRO-128)
// ============================================

// Precedence matters and is deliberate: `short` (gap > 0) always outranks
// `restage`, which outranks `low`. A SKU with staged === 0 AND a gap must
// render SHORT, not RESTAGE — a gap means demand already exceeds total
// on-hand (cased+filled+staged), which is strictly more urgent than
// "nothing staged yet, but on-hand inventory still covers demand" (restage).
//
// `restage` is the fix for the pre-SPRO-128 blind spot: the old `lowStock`
// signal required `staged > 0`, so a SKU sitting at staged===0 with open
// pending orders rendered no warning at all, even though the pipeline was
// about to run dry.
export function computeInventoryState(params: {
  staged: number;
  pending: number;
  gap: number;
}): InventoryCellState {
  const { staged, pending, gap } = params;

  if (gap > 0) return 'short';
  if (staged === 0 && pending > 0) return 'restage';
  if (staged > 0 && staged < LOW_STOCK_THRESHOLD) return 'low';
  if (staged >= LOW_STOCK_THRESHOLD) return 'ok';
  return 'idle';
}

// Mutable available inventory during allocation
interface AvailableInventory {
  cased: Map<SKU, number>;
  filled: Map<SKU, number>;
  staged: Map<SKU, number>;
}

// Order with calculated priority
interface PrioritizedOrder extends Order {
  priority: PriorityTier;
  priorityScore: number; // Lower = more urgent
}

// Task accumulator during generation
interface TaskAccumulator {
  tasks: Map<string, Task>; // Keyed by `${taskType}-${sku}`
}

// Calculate priority for an order
function calculatePriority(order: Order): PrioritizedOrder {
  const days = daysUntil(order.deliveryDate);

  let priority: PriorityTier;
  let priorityScore: number;

  if (days !== null && days <= 0) {
    // Today or past due - URGENT
    priority = 'URGENT';
    priorityScore = days; // More negative = more overdue
  } else if (days !== null && days === 1) {
    // Tomorrow - needs to be done today
    priority = 'TOMORROW';
    priorityScore = 1;
  } else if (days !== null && days <= 3) {
    // Within 2-3 days
    priority = 'UPCOMING';
    priorityScore = days;
  } else {
    // No delivery date or far future - treat as low priority upcoming
    priority = 'UPCOMING';
    priorityScore = days ?? 999;
  }

  return { ...order, priority, priorityScore };
}

// Get numeric rank for priority (lower = higher priority)
function priorityRank(tier: PriorityTier): number {
  const ranks: Record<PriorityTier, number> = {
    URGENT: 0,
    TOMORROW: 1,
    UPCOMING: 2,
    BACKFILL: 3,
  };
  return ranks[tier];
}

// Create mutable inventory clone
function createAvailableInventory(inventory: InventoryMap): AvailableInventory {
  const available: AvailableInventory = {
    cased: new Map(),
    filled: new Map(),
    staged: new Map(),
  };

  for (const sku of Object.keys(inventory)) {
    const levels = inventory[sku];
    available.cased.set(sku, levels.cased);
    available.filled.set(sku, levels.filled);
    available.staged.set(sku, levels.staged);
  }

  return available;
}

// Determine which Kanban column a task belongs in
function determineColumn(
  type: TaskType,
  status: TaskStatus,
  filledAvailable: number,
  stagedAvailable: number,
  quantity: number
): KanbanColumn {
  // Blocked tasks stay in TO_FILL
  if (status === 'BLOCKED') {
    return 'TO_FILL';
  }

  // CASE tasks go to TO_CASE (already have filled inventory)
  if (type === 'CASE') {
    return 'TO_CASE';
  }

  // FILL tasks go to TO_FILL
  return 'TO_FILL';
}

// Allocate inventory for a single SKU need, generating tasks as needed
function allocateSKU(
  available: AvailableInventory,
  accumulator: TaskAccumulator,
  order: PrioritizedOrder,
  sku: SKU,
  needed: number
): void {
  let remaining = needed;

  // Step 1: Consume from CASED (no task needed - already done)
  const availableCased = available.cased.get(sku) ?? 0;
  const fromCased = Math.min(remaining, availableCased);
  available.cased.set(sku, availableCased - fromCased);
  remaining -= fromCased;

  if (remaining === 0) return;

  // Step 2: Consume from FILLED (generate CASE task)
  const availableFilled = available.filled.get(sku) ?? 0;
  const fromFilled = Math.min(remaining, availableFilled);
  if (fromFilled > 0) {
    available.filled.set(sku, availableFilled - fromFilled);
    addToTask(accumulator, 'CASE', sku, fromFilled, order, 'TO_CASE');
    remaining -= fromFilled;
  }

  if (remaining === 0) return;

  // Step 3: Consume from STAGED (generate FILL task)
  const availableStaged = available.staged.get(sku) ?? 0;
  const fromStaged = Math.min(remaining, availableStaged);
  if (fromStaged > 0) {
    available.staged.set(sku, availableStaged - fromStaged);
    addToTask(accumulator, 'FILL', sku, fromStaged, order, 'TO_FILL');
    remaining -= fromStaged;
  }

  // Step 4: Remaining is BLOCKED (no staged inventory)
  if (remaining > 0) {
    addBlockedTask(accumulator, sku, remaining, order);
  }
}

// Add quantity to an aggregated task
function addToTask(
  accumulator: TaskAccumulator,
  type: TaskType,
  sku: SKU,
  quantity: number,
  order: PrioritizedOrder,
  column: KanbanColumn
): void {
  const taskKey = `${type}-${sku}-${order.priority}`;
  const existing = accumulator.tasks.get(taskKey);

  const source: TaskSource = {
    type: 'ORDER',
    orderId: order.id,
    customerName: order.customerName,
    quantity,
    deliveryDate: order.deliveryDate,
  };

  if (existing) {
    existing.quantity += quantity;
    existing.sources.push(source);
    // Upgrade priority if this order is higher priority
    if (priorityRank(order.priority) < priorityRank(existing.priority)) {
      existing.priority = order.priority;
    }
  } else {
    accumulator.tasks.set(taskKey, {
      id: taskKey,
      type,
      sku,
      quantity,
      priority: order.priority,
      status: 'READY',
      column,
      sources: [source],
    });
  }
}

// Add blocked task - always creates a separate blocked task
// This prevents blocking inventory that IS available for higher-priority orders
function addBlockedTask(
  accumulator: TaskAccumulator,
  sku: SKU,
  quantity: number,
  order: PrioritizedOrder
): void {
  // Use separate key for blocked tasks to keep them distinct from READY tasks
  const taskKey = `BLOCKED-FILL-${sku}`;
  const existing = accumulator.tasks.get(taskKey);

  const source: TaskSource = {
    type: 'ORDER',
    orderId: order.id,
    customerName: order.customerName,
    quantity,
    deliveryDate: order.deliveryDate,
  };

  if (existing) {
    // Add to existing blocked task
    existing.quantity += quantity;
    existing.sources.push(source);
    // Upgrade priority if this order is higher priority
    if (priorityRank(order.priority) < priorityRank(existing.priority)) {
      existing.priority = order.priority;
    }
  } else {
    accumulator.tasks.set(taskKey, {
      id: taskKey,
      type: 'FILL',
      sku,
      quantity,
      priority: order.priority,
      status: 'BLOCKED',
      column: 'TO_FILL',
      sources: [source],
      blockedReason: 'Needs Staged',
    });
  }
}

// Process backfill needs with remaining inventory
// Backfill tasks are SEPARATE from order tasks - they use different task keys
// Creates tasks for ALL remaining staged/filled inventory to keep stock moving
function processBackfill(
  available: AvailableInventory,
  accumulator: TaskAccumulator,
  originalInventory: InventoryMap
): void {
  for (const sku of Object.keys(originalInventory)) {
    // Use ALL remaining FILLED for backfill (CASE task)
    const availableFilled = available.filled.get(sku) ?? 0;
    if (availableFilled > 0) {
      available.filled.set(sku, 0);
      addBackfillTask(accumulator, 'CASE', sku, availableFilled, 'TO_CASE');
    }

    // Use ALL remaining STAGED for backfill (FILL task)
    const availableStaged = available.staged.get(sku) ?? 0;
    if (availableStaged > 0) {
      available.staged.set(sku, 0);
      addBackfillTask(accumulator, 'FILL', sku, availableStaged, 'TO_FILL');
    }
  }
}

// Add backfill task - uses separate task key to avoid mixing with order tasks
function addBackfillTask(
  accumulator: TaskAccumulator,
  type: TaskType,
  sku: SKU,
  quantity: number,
  column: KanbanColumn
): void {
  // Use BACKFILL prefix to keep separate from order tasks
  const taskKey = `BACKFILL-${type}-${sku}`;
  const existing = accumulator.tasks.get(taskKey);

  const source: TaskSource = {
    type: 'BACKFILL',
    quantity,
  };

  if (existing) {
    existing.quantity += quantity;
    existing.sources.push(source);
  } else {
    accumulator.tasks.set(taskKey, {
      id: taskKey,
      type,
      sku,
      quantity,
      priority: 'BACKFILL',
      status: 'READY',
      column,
      sources: [source],
    });
  }
}

// Calculate pending totals per SKU (sum of pending/confirmed orders)
function calculatePendingTotals(orders: Order[]): Map<SKU, number> {
  const pending = new Map<SKU, number>();

  for (const order of orders) {
    if (order.status !== 'Pending' && order.status !== 'Confirmed') continue;

    for (const item of order.lineItems) {
      const current = pending.get(item.sku) ?? 0;
      pending.set(item.sku, current + item.quantity);
    }
  }

  return pending;
}

// Main function: Generate task queue from inventory and orders
export function generateTaskQueue(
  inventory: InventoryMap,
  orders: Order[]
): Task[] {
  // Filter to actionable orders (Pending or Confirmed)
  const actionableOrders = orders.filter(
    o => o.status === 'Pending' || o.status === 'Confirmed'
  );

  // Calculate priorities and sort
  const prioritized = actionableOrders
    .map(o => calculatePriority(o))
    .sort((a, b) => {
      const tierDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (tierDiff !== 0) return tierDiff;
      return a.priorityScore - b.priorityScore;
    });

  // Create mutable available inventory
  const available = createAvailableInventory(inventory);

  // Create task accumulator
  const accumulator: TaskAccumulator = {
    tasks: new Map(),
  };

  // Process orders in priority order
  for (const order of prioritized) {
    for (const item of order.lineItems) {
      allocateSKU(available, accumulator, order, item.sku, item.quantity);
    }
  }

  // Process backfill with remaining inventory
  processBackfill(available, accumulator, inventory);

  // Convert to array and sort
  const tasks = Array.from(accumulator.tasks.values()).sort((a, b) => {
    // First by priority tier
    const tierDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (tierDiff !== 0) return tierDiff;

    // Ready tasks before blocked
    if (a.status === 'READY' && b.status === 'BLOCKED') return -1;
    if (a.status === 'BLOCKED' && b.status === 'READY') return 1;

    // FILL before CASE (must fill first)
    if (a.type === 'FILL' && b.type === 'CASE') return -1;
    if (a.type === 'CASE' && b.type === 'FILL') return 1;

    // By quantity (larger first)
    return b.quantity - a.quantity;
  });

  return tasks;
}

// Generate SKU status for inventory bar
export function generateSKUStatus(
  inventory: InventoryMap,
  orders: Order[]
): SKUStatus[] {
  const pendingTotals = calculatePendingTotals(orders);

  return Object.keys(inventory).map(sku => {
    const levels = inventory[sku];
    const pending = pendingTotals.get(sku) ?? 0;
    const totalAvailable = levels.cased + levels.filled + levels.staged;
    const gap = Math.max(0, pending - totalAvailable);

    return {
      sku,
      cased: levels.cased,
      filled: levels.filled,
      staged: levels.staged,
      pending,
      gap,
      lowStock: levels.staged < LOW_STOCK_THRESHOLD && levels.staged > 0,
      state: computeInventoryState({ staged: levels.staged, pending, gap }),
    };
  });
}

// Get tasks grouped by Kanban column
export function getTasksByColumn(tasks: Task[]): {
  toFill: Task[];
  toCase: Task[];
} {
  const toFill: Task[] = [];
  const toCase: Task[] = [];

  for (const task of tasks) {
    if (task.column === 'TO_FILL') {
      toFill.push(task);
    } else if (task.column === 'TO_CASE') {
      toCase.push(task);
    }
    // DONE tasks are stored in localStorage, not from allocation
  }

  return { toFill, toCase };
}
