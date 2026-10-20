'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { NoAccess } from './no-access'
import { useTrimAccess } from './use-trim-access'

const BASE = '/dashboard/harvest-trim'

interface NavLink {
  href: string
  label: string
  /** Hidden from roles that cannot use it. */
  needs?: 'operate' | 'weigh' | 'finance'
}

const LINKS: NavLink[] = [
  { href: BASE, label: 'Overview' },
  { href: `${BASE}/harvest`, label: 'Harvest', needs: 'weigh' },
  { href: `${BASE}/station`, label: 'Trim station', needs: 'operate' },
  { href: `${BASE}/lookup`, label: 'Look up a tag' },
  { href: `${BASE}/hangers`, label: 'Hangers' },
  { href: `${BASE}/staff`, label: 'Trimmers' },
  { href: `${BASE}/pay-register`, label: 'Pay register', needs: 'finance' },
  { href: `${BASE}/settings`, label: 'Settings' },
]

function isActive(pathname: string, href: string): boolean {
  if (href === BASE) return pathname === BASE || pathname.startsWith(`${BASE}/batches`)
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Shared frame for every Harvest & Trim page: one access check (so a deep link
 * from a role without the section gets a clean "no access" instead of a broken
 * page) and a scrollable sub-navigation styled like the app's tab strips.
 */
export function TrimShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? BASE
  const access = useTrimAccess()

  if (!access.ready) {
    return <div className="py-16 text-center text-muted-foreground">Loading...</div>
  }

  if (!access.canView) {
    return (
      <NoAccess
        title="Harvest & Trim is not available to your role"
        message="Ask an admin if you need access to the hanger and trim tools."
      />
    )
  }

  const links = LINKS.filter(
    (l) =>
      (l.needs !== 'operate' || access.canOperate) &&
      (l.needs !== 'weigh' || access.canWeigh) &&
      (l.needs !== 'finance' || access.isFinance)
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Harvest &amp; Trim</h1>
        <p className="text-muted-foreground mt-1">Hanger tracking, trim station, and trimmer pay</p>
      </div>

      <nav aria-label="Harvest and trim sections" className="overflow-x-auto scrollbar-hide">
        <ul className="inline-flex h-10 min-w-max items-center gap-1 rounded-md bg-muted p-1 text-muted-foreground">
          {links.map((l) => {
            const active = isActive(pathname, l.href)
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    active ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'
                  )}
                >
                  {l.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {children}
    </div>
  )
}
