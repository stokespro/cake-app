'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listTrimVendors, type VendorOption } from '@/actions/trim-staff'
import { useTrimRun } from './use-trim-run'

interface VendorPickerProps {
  value: string | null
  onChange: (vendorId: string | null) => void
  disabled?: boolean
}

/**
 * Which finance vendor a trimmer is paid through. Payroll vendors come first
 * (the server orders them so). A vendor is required before pay can be approved
 * (R2.14), but not to add the person, so "No vendor yet" is a real choice.
 */
export function VendorPicker({ value, onChange, disabled }: VendorPickerProps) {
  const run = useTrimRun()
  const [vendors, setVendors] = useState<VendorOption[] | null>(null)
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const res = await run(listTrimVendors(), { quiet: true })
      if (!live) return
      if (res.success) setVendors(res.data)
      else {
        setVendors([])
        setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [run])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = vendors ?? []
    return (q ? list.filter((v) => v.name.toLowerCase().includes(q)) : list).slice(0, 60)
  }, [vendors, query])

  const selected = vendors?.find((v) => v.id === value) ?? null

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search vendors"
          aria-label="Search vendors"
          disabled={disabled}
          className="pl-10"
        />
      </div>
      {selected && (
        <p className="text-sm">
          Paid through <span className="font-semibold">{selected.name}</span>
        </p>
      )}
      {failed && <p className="text-sm text-destructive">Could not load vendors.</p>}
      <div className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border p-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className={cn(
            'flex min-h-12 w-full items-center justify-between rounded-md px-3 text-left',
            value === null ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
          )}
        >
          No vendor yet
          {value === null && <Check className="h-4 w-4" />}
        </button>
        {vendors === null && <p className="p-3 text-sm text-muted-foreground">Loading vendors...</p>}
        {filtered.map((v) => (
          <button
            key={v.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(v.id)}
            className={cn(
              'flex min-h-12 w-full items-center justify-between gap-2 rounded-md px-3 text-left',
              value === v.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            )}
          >
            <span className="truncate">{v.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs opacity-80">
              {v.category}
              {value === v.id && <Check className="h-4 w-4" />}
            </span>
          </button>
        ))}
        {vendors !== null && filtered.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">No vendor matches that search.</p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Pay cannot be approved until a vendor is set. Not in the list? Ask finance to add them as a vendor first.
      </p>
      {value && (
        <Button type="button" variant="ghost" className="h-12" disabled={disabled} onClick={() => onChange(null)}>
          Clear vendor
        </Button>
      )}
    </div>
  )
}
