'use server'

import {
  readInventory,
  readOrdersRaw,
  mapOrdersFromRaw,
  readStagingContainers,
  readTaskNotes,
  readTaskStates,
  processOrderStatusChanges,
  cleanupOldTaskStates,
  completeWeighAndFill,
  completeSealAndCase,
  saveTaskState,
  saveTaskNote,
  deleteTaskState,
  addContainer as dbAddContainer,
  removeContainer as dbRemoveContainer,
  updateInventoryLevels,
  readSKUInventory,
  getSkuId,
} from '@/lib/packaging/db'
import { generateTaskQueue, generateSKUStatus } from '@/lib/packaging/allocation-engine'
import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
// DISABLED: Materials imports - re-enable when materials module is complete
// import {
//   checkMaterialAvailability,
//   deductMaterialsForCasing,
// } from '@/actions/materials'

// Roles that can access packaging actions — generous set so the shared TV
// (packaging, vault, standard) and management/admin are never locked out.
const PACKAGING_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard'] as const

import type {
  DashboardData,
  Task,
  CompletedTask,
  SKU,
  ContainerSize,
  InventoryLevels,
} from '@/lib/packaging/types'

// ============================================
// DASHBOARD DATA
// ============================================

export async function getDashboardData(): Promise<DashboardData> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) {
    return {
      inventory: [],
      tasks: [],
      containers: [],
      taskNotes: {},
      completedTasks: [],
      lastUpdated: new Date().toISOString(),
      error: auth.reason,
    }
  }

  try {
    // Single read of `orders` (+ joined customers/order_items), reused below
    // for both status-change processing and the board's Order[] list —
    // avoids querying `orders` twice per dashboard load.
    const rawOrders = await readOrdersRaw()

    // Process any order status changes (packed/delivered cased-inventory
    // deductions) using the orders we already fetched above.
    const statusChanges = await processOrderStatusChanges(rawOrders)
    if (statusChanges.packedProcessed > 0 || statusChanges.deliveredProcessed > 0 || statusChanges.reversedPacked > 0) {
      console.log('Order status changes processed:', statusChanges)
    }

    // Cleanup old DONE tasks from previous days
    const cleanedUp = await cleanupOldTaskStates()
    if (cleanedUp > 0) {
      console.log(`Cleaned up ${cleanedUp} old task states`)
    }

    const orders = mapOrdersFromRaw(rawOrders)

    // Fetch remaining data (inventory read AFTER status processing above,
    // since processOrderStatusChanges may have mutated cased inventory)
    const [inventory, containers, taskNotes, taskStates] = await Promise.all([
      readInventory(),
      readStagingContainers(),
      readTaskNotes(),
      readTaskStates(),
    ])

    // Generate task queue using allocation engine
    const tasks = generateTaskQueue(inventory, orders)

    // Calculate how much FILLED inventory is "claimed" by persisted TO_CASE tasks
    // This prevents the allocation engine from double-counting filled inventory
    const claimedFilled: Record<string, number> = {}
    for (const [taskKey, state] of Object.entries(taskStates)) {
      // Match both new format (CASE-*) and legacy format (FILL-* with TO_CASE column)
      if (state.current_column === 'TO_CASE') {
        const isCaseTask = taskKey.startsWith('CASE-') || taskKey.startsWith('BACKFILL-CASE-')
        const isLegacyFillTask = taskKey.startsWith('FILL-')
        if (isCaseTask || isLegacyFillTask) {
          const sku = state.sku
          claimedFilled[sku] = (claimedFilled[sku] || 0) + state.quantity
        }
      }
    }

    // Merge persisted task states with generated tasks
    const completedTasks: CompletedTask[] = []
    const mergedTasks: Task[] = []

    for (const task of tasks) {
      const persistedState = taskStates[task.id]

      if (persistedState) {
        if (persistedState.current_column === 'DONE') {
          completedTasks.push({
            id: task.id,
            sku: task.sku,
            quantity: persistedState.quantity,
            priority: task.priority,
            completedAt: persistedState.completed_at || new Date().toISOString(),
          })
        } else if (persistedState.current_column === 'TO_CASE' && task.column === 'TO_FILL') {
          mergedTasks.push({
            ...task,
            column: 'TO_CASE',
          })
        } else {
          mergedTasks.push(task)
        }
      } else {
        // No persisted state - check if this CASE task is using "claimed" filled inventory
        if (task.type === 'CASE' && task.column === 'TO_CASE' && claimedFilled[task.sku]) {
          // Reduce quantity by what's claimed
          const claimed = claimedFilled[task.sku]
          const adjustedQuantity = task.quantity - claimed
          
          if (adjustedQuantity > 0) {
            mergedTasks.push({
              ...task,
              quantity: adjustedQuantity,
            })
          }
          // If adjustedQuantity <= 0, skip this task entirely (all inventory claimed)
          
          // Mark this SKU's claimed inventory as handled
          claimedFilled[task.sku] = Math.max(0, claimed - task.quantity)
        } else {
          mergedTasks.push(task)
        }
      }
    }

    // Also check for DONE tasks not in generated list
    for (const [taskKey, state] of Object.entries(taskStates)) {
      if (state.current_column === 'DONE') {
        const alreadyAdded = completedTasks.some(t => t.id === taskKey)
        if (!alreadyAdded) {
          // Extract priority from task key (e.g., CASE-CM-URGENT -> URGENT)
          const parts = taskKey.split('-')
          const lastPart = parts[parts.length - 1]
          const validPriorities = ['URGENT', 'TOMORROW', 'UPCOMING', 'BACKFILL']
          const priority = validPriorities.includes(lastPart)
            ? lastPart as 'URGENT' | 'TOMORROW' | 'UPCOMING' | 'BACKFILL'
            : 'BACKFILL'

          completedTasks.push({
            id: taskKey,
            sku: state.sku as SKU,
            quantity: state.quantity,
            priority,
            completedAt: state.completed_at || new Date().toISOString(),
          })
        }
      }
    }

    // Handle persisted TO_CASE tasks that may not be in the generated list
    // This handles both:
    // 1. CASE-* tasks that were advanced from FILL and saved with proper CASE ID
    // 2. Legacy FILL-* tasks that had current_column === 'TO_CASE' (old format)
    const ghostTasksToDelete: string[] = []

    for (const [taskKey, state] of Object.entries(taskStates)) {
      if (state.current_column === 'TO_CASE') {
        // Determine if this is a CASE task (new format) or FILL task (legacy format)
        const isCaseTask = taskKey.startsWith('CASE-') || taskKey.startsWith('BACKFILL-CASE-')
        const isLegacyFillTask = taskKey.startsWith('FILL-')

        if (!isCaseTask && !isLegacyFillTask) continue

        // Extract priority and SKU from the task key
        let priority: 'URGENT' | 'TOMORROW' | 'UPCOMING' | 'BACKFILL'
        let sku: SKU
        let caseTaskKey: string

        if (taskKey.startsWith('BACKFILL-CASE-') || taskKey.startsWith('BACKFILL-FILL-')) {
          // BACKFILL-CASE-SKU or BACKFILL-FILL-SKU format
          const parts = taskKey.split('-')
          sku = parts.slice(2).join('-') as SKU
          priority = 'BACKFILL'
          caseTaskKey = `BACKFILL-CASE-${sku}`
        } else {
          // CASE-SKU-PRIORITY or FILL-SKU-PRIORITY format
          const parts = taskKey.split('-')
          priority = parts[parts.length - 1] as 'URGENT' | 'TOMORROW' | 'UPCOMING' | 'BACKFILL'
          sku = parts.slice(1, -1).join('-') as SKU // Handle SKUs like BB-B
          caseTaskKey = `CASE-${sku}-${priority}`
        }

        // Check if there's actual FILLED inventory for this SKU
        const skuInventory = inventory[sku]
        if (!skuInventory || skuInventory.filled < state.quantity) {
          // No filled inventory to back this task - it's a ghost, mark for deletion
          ghostTasksToDelete.push(taskKey)
          continue
        }

        // Check if we already have this task in merged list
        const existingCaseTask = mergedTasks.find(t => t.id === caseTaskKey)

        if (!existingCaseTask) {
          // Create a CASE task for this persisted state
          mergedTasks.push({
            id: caseTaskKey,
            type: 'CASE',
            sku: state.sku as SKU,
            quantity: state.quantity,
            priority: priority,
            status: 'READY',
            column: 'TO_CASE',
            sources: [{
              type: 'ORDER',
              orderId: 'advanced',
              customerName: 'Advanced from Fill',
              quantity: state.quantity,
              deliveryDate: null,
            }],
          })
        }
      }
    }

    // Clean up ghost task states in the background
    if (ghostTasksToDelete.length > 0) {
      console.log(`Cleaning up ${ghostTasksToDelete.length} ghost task states:`, ghostTasksToDelete)
      Promise.all(ghostTasksToDelete.map(taskKey => deleteTaskState(taskKey)))
        .catch(err => console.error('Error cleaning up ghost tasks:', err))
    }

    // Generate SKU status for inventory bar
    const skuStatus = generateSKUStatus(inventory, orders)

    // Enrich with product type info for dynamic grouping on packaging page
    try {
      const supabase = await createServiceClient()
      const { data: skuRows } = await supabase
        .from('skus')
        .select('code, product_type_id, product_types(name)')
      const typeByCode = new Map<string, { id: string; name: string }>()
      for (const row of skuRows || []) {
        const pt = Array.isArray((row as { product_types?: unknown }).product_types)
          ? (row as { product_types: { name: string }[] }).product_types[0]
          : (row as { product_types?: { name: string } }).product_types
        typeByCode.set((row as { code: string }).code, {
          id: (row as { product_type_id: string }).product_type_id,
          name: pt?.name || 'Unknown',
        })
      }
      for (const status of skuStatus) {
        const t = typeByCode.get(status.sku)
        if (t) {
          status.productTypeId = t.id
          status.productTypeName = t.name
        }
      }
    } catch (err) {
      console.error('Failed to enrich SKU status with product types:', err)
    }

    // Filter to only AVAILABLE containers
    const availableContainers = containers.filter(c => c.status === 'AVAILABLE')

    return {
      inventory: skuStatus,
      tasks: mergedTasks,
      containers: availableContainers,
      taskNotes,
      completedTasks,
      lastUpdated: new Date().toISOString(),
    }
  } catch (error) {
    console.error('Dashboard data error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return {
      inventory: [],
      tasks: [],
      containers: [],
      taskNotes: {},
      completedTasks: [],
      lastUpdated: new Date().toISOString(),
      error: `Failed to load dashboard data: ${errorMessage}`,
    }
  }
}

// ============================================
// TASK ACTIONS
// ============================================

export async function advanceTask(
  taskId: string,
  sku: SKU,
  quantity: number,
  fromColumn: 'TO_FILL' | 'TO_CASE'
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const currentInventory = await readSKUInventory(sku)

    if (fromColumn === 'TO_FILL') {
      // STAGED -> FILLED
      if (currentInventory.staged < quantity) {
        return { success: false, error: 'Insufficient staged inventory' }
      }

      await completeWeighAndFill(sku, quantity, currentInventory)

      // When advancing from FILL to CASE, we need to:
      // 1. Delete the old FILL task state (if it exists)
      // 2. Save the new CASE task state with the CASE task ID
      // 3. Copy notes from FILL to CASE task key

      // Generate the CASE task ID from the FILL task ID
      // FILL-SKU-PRIORITY -> CASE-SKU-PRIORITY
      // Also handle BACKFILL-FILL-SKU -> BACKFILL-CASE-SKU
      let caseTaskId: string
      if (taskId.startsWith('FILL-')) {
        caseTaskId = taskId.replace(/^FILL-/, 'CASE-')
      } else if (taskId.startsWith('BACKFILL-FILL-')) {
        caseTaskId = taskId.replace(/^BACKFILL-FILL-/, 'BACKFILL-CASE-')
      } else {
        // Fallback - just use the taskId as-is
        caseTaskId = taskId
      }

      // Delete the old FILL task state (don't block on this)
      deleteTaskState(taskId).catch(err => console.error('Error deleting FILL task state:', err))

      // Save the new CASE task state with the correct CASE task ID
      await saveTaskState(caseTaskId, sku, 'CASE', 'TO_CASE', quantity)

      // Copy note from FILL task to CASE task (don't block on this)
      try {
        const taskNotes = await readTaskNotes()
        const fillNote = taskNotes[taskId]
        if (fillNote) {
          saveTaskNote(caseTaskId, fillNote).catch(err => console.error('Error copying note:', err))
        }
      } catch (err) {
        console.error('Error reading notes for advance:', err)
      }
    } else if (fromColumn === 'TO_CASE') {
      // FILLED -> CASED
      if (currentInventory.filled < quantity) {
        return { success: false, error: 'Insufficient filled inventory' }
      }

      // DISABLED: Materials check temporarily disabled to unblock packaging
      // TODO: Re-enable when materials inventory module is complete
      // const skuId = await getSkuId(sku)
      // const materialCheck = await checkMaterialAvailability(skuId, quantity)
      // if (!materialCheck.success) {
      //   return { success: false, error: materialCheck.error || 'Failed to check material availability' }
      // }
      // if (materialCheck.data && !materialCheck.data.available) {
      //   const shortage = materialCheck.data.materials.find(m => m.shortage > 0)
      //   if (shortage) {
      //     return {
      //       success: false,
      //       error: `Cannot case: Insufficient ${shortage.materialName}. Need ${shortage.required}, have ${shortage.available}`
      //     }
      //   }
      //   return { success: false, error: 'Insufficient materials for casing' }
      // }
      // const deductResult = await deductMaterialsForCasing(skuId, quantity)
      // if (!deductResult.success) {
      //   return { success: false, error: deductResult.error || 'Failed to deduct materials' }
      // }

      await completeSealAndCase(sku, quantity, currentInventory)

      // Update task state to DONE
      await saveTaskState(taskId, sku, 'CASE', 'DONE', quantity)
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function revertTask(
  taskId: string,
  sku: SKU,
  quantity: number,
  fromColumn: 'TO_CASE' | 'DONE'
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const currentInventory = await readSKUInventory(sku)

    if (fromColumn === 'TO_CASE') {
      // FILLED -> STAGED (reverse of fill)
      const newFilled = Math.max(0, currentInventory.filled - quantity)
      const newStaged = currentInventory.staged + quantity

      await updateInventoryLevels(sku, { filled: newFilled, staged: newStaged }, 'task_reverted')

      // When reverting from TO_CASE to TO_FILL, we need to:
      // 1. Delete the CASE task state
      // 2. Create a FILL task state with the FILL task ID (if it had one originally)

      // Generate the FILL task ID from the CASE task ID
      // CASE-SKU-PRIORITY -> FILL-SKU-PRIORITY
      // BACKFILL-CASE-SKU -> BACKFILL-FILL-SKU
      let fillTaskId: string
      if (taskId.startsWith('CASE-')) {
        fillTaskId = taskId.replace(/^CASE-/, 'FILL-')
      } else if (taskId.startsWith('BACKFILL-CASE-')) {
        fillTaskId = taskId.replace(/^BACKFILL-CASE-/, 'BACKFILL-FILL-')
      } else {
        // Fallback - just use the taskId as-is
        fillTaskId = taskId
      }

      // Delete the CASE task state (don't await - let it happen in background)
      deleteTaskState(taskId).catch(err => console.error('Error deleting task state:', err))

      // Copy note back from CASE to FILL task (don't block on this)
      try {
        const taskNotes = await readTaskNotes()
        const caseNote = taskNotes[taskId]
        if (caseNote) {
          saveTaskNote(fillTaskId, caseNote).catch(err => console.error('Error copying note:', err))
        }
      } catch (err) {
        console.error('Error reading notes for revert:', err)
      }
    } else if (fromColumn === 'DONE') {
      // CASED -> FILLED (reverse of case)
      const newCased = Math.max(0, currentInventory.cased - quantity)
      const newFilled = currentInventory.filled + quantity

      await updateInventoryLevels(sku, { cased: newCased, filled: newFilled }, 'task_reverted')

      // Update task state back to TO_CASE
      await saveTaskState(taskId, sku, 'CASE', 'TO_CASE', quantity)
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// TASK NOTES
// ============================================

export async function updateTaskNote(
  taskId: string,
  note: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    await saveTaskNote(taskId, note)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// CONTAINERS
// ============================================

export async function addContainer(
  sku: SKU,
  size: ContainerSize
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    await dbAddContainer(sku, size)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function removeContainer(
  containerId: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    await dbRemoveContainer(containerId)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// INVENTORY
// ============================================

export async function updateInventory(
  sku: SKU,
  updates: { cased?: number; filled?: number; staged?: number }
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    await updateInventoryLevels(sku, updates, 'manual_adjustment')
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}
