'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { WorkerSelector } from '@/components/packaging-board/WorkerSelector'

export interface PickerTrimmer {
  id: string
  name: string
  /** Hangers this trimmer already holds, shown on the button. */
  hangersOut?: number
}

/** Past this many people a search box goes above the grid. */
export const SEARCH_THRESHOLD = 12

interface TrimmerPickerProps {
  staff: PickerTrimmer[]
  selectedId: string | null
  onSelect: (trimmerId: string, trimmerName: string) => void
  /** Listed first (e.g. whoever held the hanger last, on a reissue). */
  firstId?: string | null
  label?: string
}

/**
 * The trim station's "who gets this hanger" picker. It is the packaging board's
 * WorkerSelector, reused as-is (the only addition is the count of hangers each
 * person already holds, folded into the button label, and a search box once the
 * roster is too long to scan by eye).
 */
export function TrimmerPicker({ staff, selectedId, onSelect, firstId, label = 'Who is trimming this?' }: TrimmerPickerProps) {
  const [query, setQuery] = useState('')

  const users = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? staff.filter((s) => s.name.toLowerCase().includes(q) || s.id === selectedId) : staff
    const ordered = [...filtered]
    if (firstId) {
      const i = ordered.findIndex((s) => s.id === firstId)
      if (i > 0) ordered.unshift(ordered.splice(i, 1)[0])
    }
    return ordered.map((s) => ({
      id: s.id,
      name:
        (s.id === firstId ? '★ ' : '') +
        (s.hangersOut && s.hangersOut > 0 ? `${s.name} · ${s.hangersOut} out` : s.name),
    }))
  }, [staff, query, firstId, selectedId])

  if (staff.length === 0) {
    return (
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm font-medium text-amber-700 dark:text-amber-300">
        There are no active trimmers yet. Add one on the Trimmers page first.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {staff.length > SEARCH_THRESHOLD && (
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
      )}
      <WorkerSelector
        users={users}
        selectedId={selectedId}
        label={label}
        onSelect={(id, name) => onSelect(id, name.replace(/^★ /, '').replace(/ · \d+ out$/, ''))}
      />
      {firstId && users.some((u) => u.id === firstId) && (
        <p className="text-sm text-muted-foreground">{'★'} had this hanger last.</p>
      )}
      {users.length === 0 && <p className="text-sm text-muted-foreground">No trimmer matches that search.</p>}
    </div>
  )
}
