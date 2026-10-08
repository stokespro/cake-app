// SPRO-199: display helpers for the "Sales Rep" and "Updated" values shown on
// the orders page (table row, card and detail sheet), so all three render the
// same thing.
//
// The rep is the dispensary's assigned rep (customers.assigned_sales_id), NOT
// orders.agent_id (whoever keyed the order). The timestamp is orders.updated_at,
// maintained by the orders_updated_at BEFORE UPDATE trigger.
//
// Pure — safe to import from client components and tests. Takes structural
// types rather than Order/OrderRecord so both shapes satisfy it.

import { format, parseISO } from 'date-fns'

/** Label shown when a dispensary has no assigned rep (~11% of orders). */
export const UNASSIGNED_REP_LABEL = 'Unassigned'

interface OrderWithRep {
  customer?: {
    assigned_sales?: { name?: string | null } | null
  } | null
}

/**
 * The assigned rep's display name, or null when the customer is missing or has
 * no assigned rep (or the rep has no usable name). Callers render
 * UNASSIGNED_REP_LABEL in muted text for null.
 */
export function getAssignedRepName(order: OrderWithRep | null | undefined): string | null {
  const name = order?.customer?.assigned_sales?.name?.trim()
  return name ? name : null
}

/**
 * Formats an `updated_at` timestamp. updated_at is a full timestamp, so it is
 * parsed with parseISO — not parseLocalDate, which is for date-only strings.
 * `withTime` switches the list-view date ('Oct 6, 2026') to the sheet form
 * ('Oct 6, 2026 3:45 PM'). Returns null for a missing or unparseable value.
 */
export function formatOrderUpdatedAt(
  updatedAt: string | null | undefined,
  withTime = false
): string | null {
  if (!updatedAt) return null
  const parsed = parseISO(updatedAt)
  if (Number.isNaN(parsed.getTime())) return null
  return format(parsed, withTime ? 'MMM d, yyyy h:mm a' : 'MMM d, yyyy')
}
