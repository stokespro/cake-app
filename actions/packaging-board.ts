'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { readInventory, readOrders, getSkuId } from '@/lib/packaging/db'
import { generateTaskQueue } from '@/lib/packaging/allocation-engine'
import { readActiveClaims, readDoneItemsToday, insertClaim, releaseClaim, completeClaim } from '@/lib/packaging/claims'
import type { InventoryMap, PriorityTier, TaskType } from '@/lib/packaging/types'
import type {
  BoardData,
  SkuBoardCard,
  OrderLine,
  ActiveClaimSummary,
  ActiveClaimRecord,
  PackagingUser,
  OrderAlertDetails,
} from '@/lib/packaging/board-types'

// Roles that can access packaging board actions — generous set so the shared TV
// (packaging, vault, standard) and management/admin are never locked out.
const PACKAGING_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard'] as const

// ============================================
// GET BOARD DATA
// ============================================

export async function getBoardData(): Promise<BoardData> {
  const lastUpdated = new Date().toISOString()

  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) {
    return { toFillCards: [], toCaseCards: [], doneItems: [], lastUpdated, error: auth.reason }
  }

  // Soft errors — failures in claims/done-items should degrade the board
  // (still show FILL/CASE cards) rather than fail the whole request, but must
  // not be swallowed silently. Collected here and surfaced via
  // BoardData.softErrors — a field distinct from BoardData.error so the
  // consumer can tell "not authorized" / "unexpected crash" (hard failure,
  // toast-worthy) apart from "partially degraded but still usable" (quiet,
  // persistent indicator; must NOT toast on every poll of an unattended
  // display — see app/dashboard/packaging/board/page.tsx).
  const softErrors: string[] = []

  try {
    // 1. Parallel fetch: inventory, orders, active claims
    const [inventory, orders, activeClaims] = await Promise.all([
      readInventory(),
      readOrders(),
      readActiveClaims().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[packaging-board] readActiveClaims failed:', err)
        softErrors.push(`Failed to load active claims: ${msg}`)
        return [] as Awaited<ReturnType<typeof readActiveClaims>>
      }),
    ])

    // 2. Build adjusted inventory: FILL claims reduce staged
    const claimedStagedBySku: Record<string, number> = {}
    for (const claim of activeClaims) {
      if (claim.taskType === 'FILL') {
        claimedStagedBySku[claim.sku] = (claimedStagedBySku[claim.sku] ?? 0) + claim.claimedQuantity
      }
    }

    const adjustedInventory: InventoryMap = {}
    for (const [sku, levels] of Object.entries(inventory)) {
      adjustedInventory[sku] = {
        ...levels,
        staged: Math.max(0, levels.staged - (claimedStagedBySku[sku] ?? 0)),
      }
    }

    // 3. Generate tasks from adjusted inventory
    const tasks = generateTaskQueue(adjustedInventory, orders)

    // 4. Group tasks by (sku, type) into SkuBoardCards
    const cardMap = new Map<string, SkuBoardCard>()

    for (const task of tasks) {
      const cardKey = `${task.sku}-${task.type}`
      const existing = cardMap.get(cardKey)

      const lines: OrderLine[] = task.sources.map((s) => ({
        orderId: s.type === 'ORDER' ? (s.orderId ?? null) : null,
        customerName: s.type === 'ORDER' ? (s.customerName ?? null) : 'Stock build',
        quantity: s.quantity,
        priority: task.priority,
        deliveryDate: s.deliveryDate ?? null,
      }))

      if (existing) {
        existing.totalQuantity += task.quantity
        existing.orderLines.push(...lines)
        if (task.priority === 'URGENT') existing.urgentUnits += task.quantity
        else if (task.priority === 'TOMORROW') existing.tomorrowUnits += task.quantity
        else if (task.priority === 'UPCOMING') existing.upcomingUnits += task.quantity
        else if (task.priority === 'BACKFILL') existing.backfillUnits += task.quantity
        if (task.status === 'BLOCKED') existing.hasBlocked = true
      } else {
        cardMap.set(cardKey, {
          sku: task.sku,
          taskType: task.type,
          totalQuantity: task.quantity,
          urgentUnits: task.priority === 'URGENT' ? task.quantity : 0,
          tomorrowUnits: task.priority === 'TOMORROW' ? task.quantity : 0,
          upcomingUnits: task.priority === 'UPCOMING' ? task.quantity : 0,
          backfillUnits: task.priority === 'BACKFILL' ? task.quantity : 0,
          orderLines: lines,
          hasBlocked: task.status === 'BLOCKED',
          activeClaim: null,
        })
      }
    }

    // 5. Attach active claims — board claim task_key = `${taskType}-${sku}`
    // Build a lookup: claimKey -> claim
    const claimByKey = new Map<string, ActiveClaimRecord>()
    for (const claim of activeClaims) {
      claimByKey.set(`${claim.taskType}-${claim.sku}`, claim)
    }

    for (const [, card] of cardMap) {
      const claimKey = `${card.taskType}-${card.sku}`
      const claim = claimByKey.get(claimKey)
      if (claim) {
        const summary: ActiveClaimSummary = {
          id: claim.id,
          claimedByUserId: claim.claimedByUserId,
          claimedByName: claim.claimedByName,
          sessionUserId: claim.sessionUserId,
          sessionUserName: claim.sessionUserName,
          claimedQuantity: claim.claimedQuantity,
          claimedAt: claim.claimedAt,
          expiresAt: claim.expiresAt,
        }
        card.activeClaim = summary
      }
    }

    // 6. Sort cards: urgent first, then tomorrow, upcoming, backfill; tie-break urgentUnits desc
    const priorityRank: Record<PriorityTier, number> = {
      URGENT: 0,
      TOMORROW: 1,
      UPCOMING: 2,
      BACKFILL: 3,
    }

    function cardTopPriority(card: SkuBoardCard): PriorityTier {
      if (card.urgentUnits > 0) return 'URGENT'
      if (card.tomorrowUnits > 0) return 'TOMORROW'
      if (card.upcomingUnits > 0) return 'UPCOMING'
      return 'BACKFILL'
    }

    function sortCards(cards: SkuBoardCard[]): SkuBoardCard[] {
      return cards.sort((a, b) => {
        const aPri = priorityRank[cardTopPriority(a)]
        const bPri = priorityRank[cardTopPriority(b)]
        if (aPri !== bPri) return aPri - bPri
        return b.urgentUnits - a.urgentUnits
      })
    }

    const allCards = Array.from(cardMap.values())
    const toFillCards = sortCards(allCards.filter((c) => c.taskType === 'FILL'))
    const toCaseCards = sortCards(allCards.filter((c) => c.taskType === 'CASE'))

    // 7. Done items
    const doneItems = await readDoneItemsToday().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[packaging-board] readDoneItemsToday failed:', err)
      softErrors.push(`Failed to load done items: ${msg}`)
      return []
    })

    return {
      toFillCards,
      toCaseCards,
      doneItems,
      lastUpdated,
      ...(softErrors.length > 0 ? { softErrors } : {}),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      toFillCards: [],
      toCaseCards: [],
      doneItems: [],
      lastUpdated,
      error: msg,
    }
  }
}

// ============================================
// GET PACKAGING USERS
// ============================================

export async function getPackagingUsers(): Promise<PackagingUser[]> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) throw new Error(auth.reason)

  const supabase = await createServiceClient()
  const { data, error } = await supabase
    .from('users')
    .select('id, name, role')
    .in('role', ['vault', 'packaging', 'management', 'admin'])
    .order('name', { ascending: true })

  if (error) throw new Error(`Failed to fetch packaging users: ${error.message}`)
  return (data || []) as PackagingUser[]
}

// ============================================
// GET ORDER ALERT DETAILS
// ============================================
// Enrichment for the packaging-board order-alert bar (hooks/use-order-alerts.ts).
// The anon/authenticated Supabase role has no SELECT grant on `customers` or
// `order_items`/`skus`, so those lookups must go through the service-role
// client server-side rather than the browser client used for the realtime
// subscription itself.

export async function getOrderAlertDetails(orderId: string): Promise<OrderAlertDetails | null> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return null

  const supabase = await createServiceClient()

  const [orderRes, itemsRes] = await Promise.all([
    supabase
      .from('orders')
      .select('order_number, customer_id, customers(business_name)')
      .eq('id', orderId)
      .single(),
    supabase
      .from('order_items')
      .select('sku_id, quantity, skus(code, name)')
      .eq('order_id', orderId),
  ])

  const customerRaw = orderRes.data?.customers as unknown as { business_name: string } | null
  const customerName = customerRaw?.business_name ?? 'Unknown dispensary'

  const items = (itemsRes.data ?? []).map((item) => {
    const skuData = item.skus as unknown as { code: string; name: string } | null
    const skuName = skuData ? `${skuData.name} (${skuData.code})` : item.sku_id
    return { skuId: item.sku_id, skuName, quantity: item.quantity }
  })

  return {
    orderNumber: orderRes.data?.order_number ?? null,
    customerName,
    items,
  }
}

// ============================================
// GET SKU NAMES
// ============================================
// Resolves a batch of sku IDs to display names ("name (code)") — used by the
// order-edited diff path, which may reference a sku from a removed/replaced
// order_items row that's no longer joinable through getOrderAlertDetails.

export async function getSkuNames(skuIds: string[]): Promise<Record<string, string>> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return {}
  if (skuIds.length === 0) return {}

  const supabase = await createServiceClient()
  const { data } = await supabase
    .from('skus')
    .select('id, code, name')
    .in('id', skuIds)

  const result: Record<string, string> = {}
  for (const row of data ?? []) {
    result[row.id] = `${row.name} (${row.code})`
  }
  return result
}

// ============================================
// CLAIM TASK
// ============================================

export interface ClaimTaskParams {
  taskKey: string
  sku: string
  taskType: TaskType
  priority: PriorityTier
  claimedQuantity: number
  claimedByUserId: string
  claimedByName: string
  sessionUserId: string | null
  sessionUserName: string | null
}

export type ClaimTaskResult =
  | { success: true; claimId: string }
  | { success: false; error: string }

export async function claimTask(params: ClaimTaskParams): Promise<ClaimTaskResult> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  return insertClaim({
    taskKey: params.taskKey,
    sku: params.sku,
    taskType: params.taskType,
    priority: params.priority,
    claimedQuantity: params.claimedQuantity,
    claimedByUserId: params.claimedByUserId,
    claimedByName: params.claimedByName,
    sessionUserId: params.sessionUserId,
    sessionUserName: params.sessionUserName,
  })
}

// ============================================
// RELEASE TASK
// ============================================

export interface ReleaseTaskParams {
  claimId: string
  releasedByUserId: string
  releasedByName: string
  reason?: string
}

export type ReleaseTaskResult =
  | { success: true }
  | { success: false; error: string }

export async function releaseTask(params: ReleaseTaskParams): Promise<ReleaseTaskResult> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()

  // Fetch the claim
  const { data: claim, error: fetchError } = await supabase
    .from('packaging_claims')
    .select('id, status, claimed_by_user_id, claimed_by_name')
    .eq('id', params.claimId)
    .single()

  if (fetchError || !claim) {
    return { success: false, error: 'Claim not found' }
  }

  if (claim.status !== 'ACTIVE') {
    return { success: false, error: `Claim is already ${String(claim.status).toLowerCase()}` }
  }

  // Authorize: worker can release own claim; admin/management can release any
  const isSelf = claim.claimed_by_user_id === params.releasedByUserId

  if (!isSelf) {
    // Fetch releasor role from DB (do not trust client)
    const { data: releasorUser, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', params.releasedByUserId)
      .single()

    if (userError || !releasorUser) {
      return { success: false, error: 'Could not verify your permissions' }
    }

    const role = releasorUser.role as string
    if (role !== 'admin' && role !== 'management') {
      return { success: false, error: 'You can only release your own claims' }
    }
  }

  return releaseClaim({
    claimId: params.claimId,
    reason: params.reason ?? 'worker_released',
  })
}

// ============================================
// ADVANCE CLAIMED
// ============================================

export interface AdvanceClaimedParams {
  claimId: string
  sku: string
  taskType: TaskType
  actualQuantity: number
  advancedByUserId: string
}

export type AdvanceClaimedResult =
  | { success: true }
  | { success: false; error: string }

export async function advanceClaimed(params: AdvanceClaimedParams): Promise<AdvanceClaimedResult> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const supabase = await createServiceClient()
  const qty = params.actualQuantity

  // 1. Validate claim: active, not expired
  const { data: claim, error: fetchError } = await supabase
    .from('packaging_claims')
    .select('id, status, expires_at, claimed_quantity, sku, task_type')
    .eq('id', params.claimId)
    .single()

  if (fetchError || !claim) {
    return { success: false, error: 'Claim not found' }
  }

  if (claim.status !== 'ACTIVE') {
    return { success: false, error: `Claim is already ${String(claim.status).toLowerCase()}` }
  }

  if (new Date(claim.expires_at) < new Date()) {
    return { success: false, error: 'Claim has expired — please re-claim the task' }
  }

  if (qty < 1 || qty > claim.claimed_quantity) {
    return {
      success: false,
      error: `Quantity must be between 1 and ${claim.claimed_quantity}`,
    }
  }

  // 2. Resolve sku_id
  let skuId: string
  try {
    skuId = await getSkuId(params.sku)
  } catch {
    return { success: false, error: `Unknown SKU: ${params.sku}` }
  }

  // 3. Atomic inventory move
  if (params.taskType === 'FILL') {
    // staged -> filled: read current, guard, then update
    const { data: invData, error: invError } = await supabase
      .from('inventory')
      .select('staged, filled')
      .eq('sku_id', skuId)
      .single()

    if (invError || !invData) {
      return { success: false, error: 'Could not read inventory' }
    }

    if (invData.staged < qty) {
      return { success: false, error: 'Insufficient staged inventory — another worker may have advanced' }
    }

    const { error: updateError } = await supabase
      .from('inventory')
      .update({
        staged: invData.staged - qty,
        filled: invData.filled + qty,
      })
      .eq('sku_id', skuId)
      .gte('staged', qty) // atomic guard

    if (updateError) {
      return { success: false, error: `Inventory update failed: ${updateError.message}` }
    }

    // Write inventory logs (informational, non-blocking)
    await Promise.allSettled([
      supabase.from('inventory_log').insert({
        sku_id: skuId,
        field: 'staged',
        old_value: invData.staged,
        new_value: invData.staged - qty,
        reason: 'board_fill_complete',
        task_id: params.claimId,
      }),
      supabase.from('inventory_log').insert({
        sku_id: skuId,
        field: 'filled',
        old_value: invData.filled,
        new_value: invData.filled + qty,
        reason: 'board_fill_complete',
        task_id: params.claimId,
      }),
    ])
  } else {
    // CASE: filled -> cased (atomic)
    const { data: invData, error: invError } = await supabase
      .from('inventory')
      .select('filled, cased')
      .eq('sku_id', skuId)
      .single()

    if (invError || !invData) {
      return { success: false, error: 'Could not read inventory' }
    }

    if (invData.filled < qty) {
      return { success: false, error: 'Insufficient filled inventory — another worker may have advanced' }
    }

    const { error: updateError } = await supabase
      .from('inventory')
      .update({
        filled: invData.filled - qty,
        cased: invData.cased + qty,
      })
      .eq('sku_id', skuId)
      .gte('filled', qty) // atomic guard

    if (updateError) {
      return { success: false, error: `Inventory update failed: ${updateError.message}` }
    }

    // Write inventory logs (informational)
    await Promise.allSettled([
      supabase.from('inventory_log').insert({
        sku_id: skuId,
        field: 'filled',
        old_value: invData.filled,
        new_value: invData.filled - qty,
        reason: 'board_case_complete',
        task_id: params.claimId,
      }),
      supabase.from('inventory_log').insert({
        sku_id: skuId,
        field: 'cased',
        old_value: invData.cased,
        new_value: invData.cased + qty,
        reason: 'board_case_complete',
        task_id: params.claimId,
      }),
    ])
  }

  // 4. Complete the claim
  const result = await completeClaim({ claimId: params.claimId, actualQuantity: qty })
  return result
}
