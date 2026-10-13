'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Scissors } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NoAccess } from './no-access'
import { useTrimAccess } from './use-trim-access'

const BASE = '/dashboard/harvest-trim'

interface NavLink {
  href: string
  label: string
  /** Hidden from roles that cannot use it. */
  needs?: 'operate'
}

const LINKS: NavLink[] = [
  { href: BASE, label: 'Overview' },
  { href: `${BASE}/station`, label: 'Trim station', needs: 'operate' },
  { href: `${BASE}/lookup`, label: 'Look up a tag' },
  { href: `${BASE}/hangers`, label: 'Hangers' },
  { href: `${BASE}/staff`, label: 'Trimmers' },
  { href: `${BASE}/settings`, label: 'Settings' },
]

function isActive(pathname: string, href: string): boolean {
  if (href === BASE) return pathname === BASE || pathname.startsWith(`${BASE}/batches`)
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Shared frame for every Harvest & Trim page: one access check (so a deep link
 * from a role without the section gets a clean "no access" instead of a broken
 * page) and a scrollable sub-navigation with 56px targets.
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

  const links = LINKS.filter((l) => l.needs !== 'operate' || access.canOperate)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Scissors className="h-6 w-6 text-emerald-500" />
        <h1 className="text-2xl font-bold">Harvest &amp; Trim</h1>
      </div>

      <nav aria-label="Harvest and trim sections" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex min-w-max gap-2">
          {links.map((l) => {
            const active = isActive(pathname, l.href)
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-14 items-center rounded-lg border-2 px-4 text-sm font-semibold transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background hover:bg-muted'
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
