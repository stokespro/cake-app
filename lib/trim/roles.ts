// Harvest & Trim role sets.
//
// Lives in lib/ (not in an actions/ file) because a 'use server' file may only
// export async functions — action files import these arrays instead. Plain
// `string[]` (not readonly tuples) so they pass straight into
// requireRole(allowedRoles: string[]).
//
// RLS is not a backstop in this app: authorization is these arrays plus
// requireRole() in every action. A role missing here means "denied".
//
// trim_manager is a strict superset of packaging elsewhere in the app (R2.4);
// that sweep is outside this file. Nothing here grants vault, packaging or
// finance — the pay workflow reaches the finance bills table only through a
// SECURITY DEFINER function, never through requireFinance().

/** Read the module: hub, batch pages, hanger lookup. */
export const TRIM_VIEW_ROLES: string[] = ['admin', 'management', 'trim_manager', 'grow']

/** Harvest-day weigh-in. `grow` cuts the room, so they weigh; they get nothing at the trim station. */
export const HARVEST_WEIGH_ROLES: string[] = ['admin', 'management', 'trim_manager', 'grow']

/** Trim station operations: dry weight, checkout, check-in, variance, void, hanger registry. */
export const TRIM_OPS_ROLES: string[] = ['admin', 'management', 'trim_manager']

/** Trim staff CRUD *and pay rates* — the trim manager hires and negotiates (R2.15). */
export const TRIM_STAFF_ADMIN_ROLES: string[] = ['admin', 'management', 'trim_manager']

/** Approve an amount owed, which raises the finance bill (R2.14). */
export const TRIM_PAY_APPROVE_ROLES: string[] = ['admin', 'management', 'trim_manager']

/** Variance settings, reopen a reconciled load or closed batch, void a partial load. */
export const TRIM_ADMIN_ROLES: string[] = ['admin', 'management']

/** True when `role` is in `allowed`. Unknown or null roles are denied. */
export function roleAllowed(allowed: readonly string[], role: string | null | undefined): boolean {
  return !!role && allowed.includes(role)
}
