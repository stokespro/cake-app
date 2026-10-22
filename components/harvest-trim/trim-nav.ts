// Navigation model for the Harvest & Trim shell. Pure, so the active-tab rules are unit-tested.
//
// Hangers and Trimmers live under Settings in the UI, but their routes did not move
// (/staff/[id] is deep-linked from the trimmer list and the Overview), so Settings simply
// claims all three path prefixes.

export const BASE = '/dashboard/harvest-trim'

export interface NavLink {
  href: string
  label: string
  /** Hidden from roles that cannot use it. */
  needs?: 'operate' | 'weigh' | 'finance'
}

/** The primary strip. /lookup is intentionally absent: the page stays (Reports and the Overview link to it). */
export const LINKS: NavLink[] = [
  { href: BASE, label: 'Overview' },
  { href: `${BASE}/harvest`, label: 'Harvest', needs: 'weigh' },
  { href: `${BASE}/station`, label: 'Trim station', needs: 'operate' },
  { href: `${BASE}/reports`, label: 'Reports' },
  { href: `${BASE}/pay-register`, label: 'Pay register', needs: 'finance' },
  { href: `${BASE}/settings`, label: 'Settings' },
]

/** The secondary strip shown on the three Settings pages. None of these has a `needs` gate. */
export const SETTINGS_TABS: NavLink[] = [
  { href: `${BASE}/settings`, label: 'Settings' },
  { href: `${BASE}/hangers`, label: 'Hangers' },
  { href: `${BASE}/staff`, label: 'Trimmers' },
]

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** True on Settings, Hangers and Trimmers (including a single trimmer's page). */
export function inSettingsGroup(pathname: string): boolean {
  return SETTINGS_TABS.some((t) => matches(pathname, t.href))
}

/** Active state for a tab in the primary strip. */
export function isActive(pathname: string, href: string): boolean {
  if (href === BASE) return pathname === BASE || pathname.startsWith(`${BASE}/batches`)
  // The top-level Settings tab stays lit across its sub-strip.
  if (href === `${BASE}/settings`) return inSettingsGroup(pathname)
  return matches(pathname, href)
}

/** Active state for a tab in the Settings sub-strip: only the page you are on. */
export function isSubActive(pathname: string, href: string): boolean {
  return matches(pathname, href)
}
