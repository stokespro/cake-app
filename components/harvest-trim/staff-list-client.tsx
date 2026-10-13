'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { listTrimStaff, type TrimStaffRow } from '@/actions/trim-staff'
import { trimmerName } from './format'
import { StaffForm } from './staff-form'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'

export function StaffListClient() {
  const access = useTrimAccess()
  const run = useTrimRun()
  const router = useRouter()
  const [staff, setStaff] = useState<TrimStaffRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const res = await run(listTrimStaff({ includeInactive: true }), { quiet: true })
    if (res.success) {
      setStaff(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [run])

  useEffect(() => {
    void load()
  }, [load])
  useRefetchOnFocus(() => void load())

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (staff ?? []).filter(
      (s) =>
        (showInactive || s.isActive) &&
        (!q || s.fullName.toLowerCase().includes(q) || (s.displayName ?? '').toLowerCase().includes(q))
    )
  }, [staff, query, showInactive])

  const inactiveCount = (staff ?? []).filter((s) => !s.isActive).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Trimmers</h2>
        {access.canManageStaff && (
          <Button type="button" className="h-12 px-5 text-base font-semibold" onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add a trimmer
          </Button>
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search trimmers"
          aria-label="Search trimmers"
          className="pl-10"
        />
      </div>

      {inactiveCount > 0 && (
        <label className="flex min-h-12 cursor-pointer items-center gap-3">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} />
          <span className="text-base">
            Show inactive <span className="text-muted-foreground">({inactiveCount})</span>
          </span>
        </label>
      )}

      {error && !staff && <ErrorState title="Could not load trimmers" message={error} onRetry={() => void load()} />}
      {!staff && !error && <p className="py-8 text-center text-muted-foreground">Loading trimmers...</p>}

      {staff && visible.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {staff.length === 0 ? 'No trimmers yet.' : 'Nobody matches that.'}
          </CardContent>
        </Card>
      )}

      <ul className="grid gap-2 md:grid-cols-2">
        {visible.map((s) => (
          <li key={s.id}>
            <Link
              href={`${BASE}/staff/${s.id}`}
              className={cn(
                'flex min-h-20 items-center justify-between gap-3 rounded-xl border-2 bg-card p-4 transition-colors hover:bg-muted/40',
                !s.isActive && 'opacity-70'
              )}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-lg font-bold">{trimmerName(s)}</p>
                {s.displayName && <p className="truncate text-sm text-muted-foreground">{s.fullName}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {!s.isActive && <span className="font-semibold">Inactive</span>}
                  {access.canSeePay && s.payPerLb !== null && (
                    <span className="font-semibold text-foreground">${s.payPerLb.toFixed(2)} / lb</span>
                  )}
                  {s.phone && <span>{s.phone}</span>}
                </div>
                {access.canManageStaff && s.isActive && !s.vendorId && (
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                    No vendor yet: pay cannot be approved
                  </p>
                )}
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>

      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent side="bottom" className="max-h-[94vh] md:ml-auto md:h-full md:max-h-none md:max-w-lg md:[--radix-sheet-content-transform:translateX(100%)]">
          <SheetHeader className="pb-4">
            <SheetTitle>Add a trimmer</SheetTitle>
            <SheetDescription>Set the pay rate now. It applies to hangers issued from here on.</SheetDescription>
          </SheetHeader>
          <StaffForm
            onSaved={(id) => {
              setAdding(false)
              toast.success('Trimmer added')
              router.push(`${BASE}/staff/${id}`)
            }}
            onCancel={() => setAdding(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}
