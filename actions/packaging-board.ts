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
  OrderAlertData,
  OrderAlertItem,
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
// ORDER ALERTS — signal-then-discover
// ============================================
// Backs the packaging-board order-alert bar (hooks/use-order-alerts.ts).
//
// Root cause of the "Unknown dispensary / 0 items" bug: `orders`/`order_items`
// have RLS enabled with no SELECT grant for anon/authenticated, so Supabase
// Realtime delivers postgres_changes events for those tables with the row
// REDACTED (payload.new/payload.old come back empty, with a 401 in
// payload.errors). Reading `payload.new.id` off those events (as the prior
// fix did) hands a lookup `undefined`, producing `id=eq.undefined` — a
// Postgres 22P02 error — and the "Unknown dispensary" / 0-item fallback.
//
// Fix: the browser never reads row content off the payload. Realtime events
// are used purely as a "something changed, go look" trigger; discovery of
// WHAT changed happens here, via the service-role client, keyed on DB
// timestamps rather than anything sourced from the payload.
//
// `orders.created_at` marks new orders. `orders.last_edited_at` is the
// signal for edits — every content-editing path (saveOrder,
// updateOrderFromSheet) sets it unconditionally, so it's a reliable
// "this order was touched" marker (unlike `updated_at`, which `saveOrder`
// doesn't set at all). Note `updateOrderStatus` (plain approve/pack/deliver
// status flips) also sets `last_edited_at` — the hook only triggers the
// edited-order check off `order_items` table events (which status-only
// transitions never fire), not off `orders` UPDATE, to avoid that producing
// a false "order edited" alert on every status change. See
// hooks/use-order-alerts.ts for the trigger wiring.

const ORDER_ALERT_FETCH_LIMIT = 20

function mapOrderAlertRow(
  row: {
    id: string
    order_number: string | null
    created_at: string | null
    last_edited_at: string | null
    customers: { business_name: string } | { business_name: string }[] | null
    order_items: { sku_id: string; quantity: number; skus: { code: string; name: string } | { code: string; name: string }[] | null }[] | null
  },
  kind: 'new' | 'edited'
): OrderAlertData {
  const customerRaw = Array.isArray(row.customers) ? row.customers[0] : row.customers
  const customerName = customerRaw?.business_name ?? 'Unknown dispensary'

  const items: OrderAlertItem[] = (row.order_items ?? []).map((item) => {
    const skuData = Array.isArray(item.skus) ? item.skus[0] : item.skus
    const skuName = skuData ? `${skuData.name} (${skuData.code})` : item.sku_id
    return { skuId: item.sku_id, skuName, quantity: item.quantity }
  })

  const eventAt = (kind === 'new' ? row.created_at : row.last_edited_at) ?? row.created_at ?? new Date(0).toISOString()

  return {
    orderId: row.id,
    orderNumber: row.order_number,
    customerName,
    items,
    kind,
    eventAt,
  }
}

const ORDER_ALERT_SELECT = `
  id,
  order_number,
  created_at,
  last_edited_at,
  customers ( business_name ),
  order_items ( sku_id, quantity, skus ( code, name ) )
`

/**
 * Cheap "what's the newest thing in `orders` right now" lookup, used to
 * seed the alert bar's high-water mark on mount so it doesn't replay
 * history — only orders created/edited AFTER this baseline should alert.
 * Falls back to the request time if the table is empty or the query fails,
 * which is safe (it just means "nothing older can match").
 */
export async function getLatestOrderEventTimestamp(): Promise<string> {
  const nowIso = new Date().toISOString()

  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return nowIso

  const supabase = await createServiceClient()

  const [createdRes, editedRes] = await Promise.all([
    supabase.from('orders').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from('orders')
      .select('last_edited_at')
      .not('last_edited_at', 'is', null)
      .order('last_edited_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const candidates = [createdRes.data?.created_at, editedRes.data?.last_edited_at, nowIso].filter(
    (v): v is string => !!v
  )

  return candidates.reduce((max, ts) => (ts > max ? ts : max), candidates[0] ?? nowIso)
}

/**
 * Discovers orders that are new (created_at > sinceIso) or edited
 * (last_edited_at > sinceIso) since the caller's high-water mark, fully
 * enriched with customer name + item list. This is the ONLY source of
 * order-alert content — see the module doc comment above for why.
 *
 * Returned newest-first by eventAt, capped at ORDER_ALERT_FETCH_LIMIT.
 */
export async function fetchRecentOrderAlerts({ sinceIso }: { sinceIso: string }): Promise<OrderAlertData[]> {
  const auth = await requireRole([...PACKAGING_ROLES])
  if (!auth.authorized) return []

  // Guard against a falsy/malformed high-water mark — never let this fall
  // through to an unbounded query.
  if (!sinceIso || Number.isNaN(Date.parse(sinceIso))) return []

  const supabase = await createServiceClient()

  const [createdRes, editedRes] = await Promise.all([
    supabase
      .from('orders')
      .select(ORDER_ALERT_SELECT)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(ORDER_ALERT_FETCH_LIMIT),
    supabase
      .from('orders')
      .select(ORDER_ALERT_SELECT)
      .gt('last_edited_at', sinceIso)
      .order('last_edited_at', { ascending: false })
      .limit(ORDER_ALERT_FETCH_LIMIT),
  ])

  if (createdRes.error) console.error('[packaging-board] fetchRecentOrderAlerts (new) error:', createdRes.error)
  if (editedRes.error) console.error('[packaging-board] fetchRecentOrderAlerts (edited) error:', editedRes.error)

  // Dedupe by order id — an order that's both newly created AND edited
  // within the same window is reported once, as 'new' (it has no prior
  // state for the client to have already alerted on).
  const byId = new Map<string, OrderAlertData>()

  for (const row of createdRes.data ?? []) {
    byId.set(row.id, mapOrderAlertRow(row, 'new'))
  }
  for (const row of editedRes.data ?? []) {
    if (byId.has(row.id)) continue
    byId.set(row.id, mapOrderAlertRow(row, 'edited'))
  }

  return Array.from(byId.values())
    .sort((a, b) => (a.eventAt < b.eventAt ? 1 : -1))
    .slice(0, ORDER_ALERT_FETCH_LIMIT)
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

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        staged: invData.staged - qty,
        filled: invData.filled + qty,
      })
      .eq('sku_id', skuId)
      .gte('staged', qty) // atomic guard
      .select('sku_id')

    if (updateError) {
      return { success: false, error: `Inventory update failed: ${updateError.message}` }
    }

    // SPRO-131: the `.gte()` guard is what makes this atomic, but a guard that
    // rejects matches zero rows — and a zero-row UPDATE is not an error. Without
    // this check the claim below would be completed against inventory that never
    // moved, which is the same silent-no-op that broke staging.
    if (!updated || updated.length === 0) {
      return {
        success: false,
        error: 'Insufficient staged inventory — another worker may have advanced',
      }
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

    const { data: updated, error: updateError } = await supabase
      .from('inventory')
      .update({
        filled: invData.filled - qty,
        cased: invData.cased + qty,
      })
      .eq('sku_id', skuId)
      .gte('filled', qty) // atomic guard
      .select('sku_id')

    if (updateError) {
      return { success: false, error: `Inventory update failed: ${updateError.message}` }
    }

    // See the FILL branch above — a rejected guard is a zero-row UPDATE, not an
    // error, and must not be allowed to complete the claim (SPRO-131).
    if (!updated || updated.length === 0) {
      return {
        success: false,
        error: 'Insufficient filled inventory — another worker may have advanced',
      }
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
