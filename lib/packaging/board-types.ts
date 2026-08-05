import type { PriorityTier, TaskType } from './types'

// A packaged SKU card shown on the board (aggregated from tasks)
export interface SkuBoardCard {
  sku: string
  taskType: TaskType
  totalQuantity: number
  urgentUnits: number
  tomorrowUnits: number
  upcomingUnits: number
  backfillUnits: number
  orderLines: OrderLine[]
  hasBlocked: boolean
  activeClaim: ActiveClaimSummary | null
}

// A single order line within a SKU card
export interface OrderLine {
  orderId: string | null
  customerName: string | null
  quantity: number
  priority: PriorityTier
  deliveryDate: string | null
}

// Summary of an active packaging claim (as stored on SkuBoardCard)
export interface ActiveClaimSummary {
  id: string
  claimedByUserId: string
  claimedByName: string
  sessionUserId: string | null
  sessionUserName: string | null
  claimedQuantity: number
  claimedAt: string
  expiresAt: string
}

// Extended claim with lookup fields returned from readActiveClaims
export interface ActiveClaimRecord extends ActiveClaimSummary {
  taskKey: string
  sku: string
  taskType: import('./types').TaskType
}

// A completed item shown in the DONE column
export interface DoneItem {
  id: string
  sku: string
  taskType: TaskType
  completedQuantity: number
  completedByName: string
  completedAt: string
}

// Full board data returned from getBoardData.
//
// `error` and `softErrors` are deliberately distinct fields, not one shared
// string:
// - `error` is a HARD failure — not authorized (`auth.reason`), or an
//   unexpected exception. When set, the board arrays are empty and the
//   consumer should surface this prominently (e.g. a toast) — something is
//   actually broken.
// - `softErrors` is non-fatal, partial degradation — e.g. active claims or
//   today's done items failed to load, but the FILL/CASE cards themselves
//   still rendered from inventory/orders. The board is usable; the consumer
//   should show a quiet, persistent indicator (no toast) since this field
//   can legitimately stay populated indefinitely on an unattended display
//   and re-fires on every poll.
export interface BoardData {
  toFillCards: SkuBoardCard[]
  toCaseCards: SkuBoardCard[]
  doneItems: DoneItem[]
  lastUpdated: string
  error?: string
  softErrors?: string[]
}

// A user eligible to be a packaging worker
export interface PackagingUser {
  id: string
  name: string
  role: string
}

// A single line item on an order, resolved for display in the order-alert
// bar (see actions/packaging-board.ts:getOrderAlertDetails)
export interface OrderAlertItem {
  skuId: string
  skuName: string // human-readable, e.g. "Blue Dream 3.5g (BD-35)"
  quantity: number
}

// Enrichment payload for a single order alert (new-order or order-edited
// toast/panel) — customer name + order number + current item list, resolved
// server-side via the service-role client since anon cannot read
// `customers` or `order_items`/`skus` directly.
export interface OrderAlertDetails {
  orderNumber: string | null
  customerName: string
  items: OrderAlertItem[]
}
