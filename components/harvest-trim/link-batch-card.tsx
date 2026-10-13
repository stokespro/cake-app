'use client'

import { useCallback, useEffect, useState } from 'react'
import { Link2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { linkBatchToCycle, listUnlinkedBatches, type BatchOption } from '@/actions/harvest-trim'
import { useTrimRun } from './use-trim-run'

interface LinkBatchCardProps {
  cycleId: string
  /** The cycle already has batches: collapse this behind a button. */
  collapsed: boolean
  onLinked: () => void
}

/**
 * Attach an existing (legacy) batch to the cycle on screen. Linking is
 * provenance only: it writes the batch's cycle and harvest date and never
 * touches the cycle itself (cycle dates stay authoritative).
 */
export function LinkBatchCard({ cycleId, collapsed, onLinked }: LinkBatchCardProps) {
  const run = useTrimRun()
  const [open, setOpen] = useState(!collapsed)
  const [query, setQuery] = useState('')
  const [batches, setBatches] = useState<BatchOption[] | null>(null)
  const [linking, setLinking] = useState<string | null>(null)

  const search = useCallback(
    async (q: string) => {
      const res = await run(listUnlinkedBatches(q), { quiet: true })
      setBatches(res.success ? res.data : [])
    },
    [run]
  )

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => void search(query), 250)
    return () => clearTimeout(t)
  }, [open, query, search])

  async function link(batch: BatchOption) {
    setLinking(batch.id)
    const res = await run(linkBatchToCycle(batch.id, cycleId))
    setLinking(null)
    if (res.success) {
      toast.success(`${batch.name} linked to this cycle`)
      setBatches((prev) => prev?.filter((b) => b.id !== batch.id) ?? null)
      onLinked()
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" className="h-14 w-full" onClick={() => setOpen(true)}>
        <Link2 className="mr-2 h-4 w-4" />
        Link an existing batch to this cycle
      </Button>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <div>
          <p className="text-lg font-semibold">Link an existing batch</p>
          <p className="text-sm text-muted-foreground">
            For batches created before this module, so their hangers and yield show up under the right cycle. New
            batches are declared above, or when the room advances to harvest (Cultivation).
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search batch name, e.g. 0723-F1"
            aria-label="Search unlinked batches"
            className="h-14 pl-10 text-base"
          />
        </div>
        {batches === null ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : batches.length === 0 ? (
          <p className="text-muted-foreground">No unlinked batches match.</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {batches.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{b.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{b.strainName ?? 'No strain'}</p>
                </div>
                <Button
                  type="button"
                  className="h-14 shrink-0 px-5"
                  disabled={linking !== null}
                  onClick={() => void link(b)}
                >
                  {linking === b.id ? 'Linking...' : 'Link'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {collapsed && (
          <Button type="button" variant="ghost" className="h-14 w-full" onClick={() => setOpen(false)}>
            Close
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
