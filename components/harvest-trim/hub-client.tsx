'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, RefreshCw, ScanLine, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  getTrimBoard,
  listHarvestCycles,
  type BoardBatch,
  type CycleOption,
  type TrimBoard,
} from '@/actions/harvest-trim'
import { ErrorState } from '@/components/ui/error-state'
import { LOAD_STATUS_META, LOAD_STATUS_ORDER, agoText, dateOnlyText, lbText, plantsText } from './format'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'
const CYCLE_KEY = 'harvest-trim-hub-cycle'
const ALL = 'all'

function cycleLabel(c: CycleOption): string {
  const room = c.roomName ?? (c.roomNumber !== null ? `Room ${c.roomNumber}` : 'Room')
  return `${room}${c.cycleNumber !== null ? ` · Cycle ${c.cycleNumber}` : ''}`
}

function readStoredCycle(): string | null {
  try {
    return window.localStorage.getItem(CYCLE_KEY)
  } catch {
    return null
  }
}

export function HubClient() {
  const access = useTrimAccess()
  const run = useTrimRun()

  const [cycles, setCycles] = useState<CycleOption[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [board, setBoard] = useState<TrimBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadBoard = useCallback(
    async (cycleKey: string, manual = false) => {
      if (manual) setRefreshing(true)
      const res = await run(getTrimBoard(cycleKey === ALL ? {} : { cycleId: cycleKey }), { quiet: true })
      if (res.success) {
        setBoard(res.data)
        setError(null)
      } else {
        setError(res.error)
      }
      setRefreshing(false)
    },
    [run]
  )

  // Cycles first; the default pick is the cycle that is drying or trimming (where the work is).
  useEffect(() => {
    let live = true
    void (async () => {
      const res = await run(listHarvestCycles(), { quiet: true })
      if (!live) return
      if (!res.success) {
        setError(res.error)
        setCycles([])
        return
      }
      setCycles(res.data)
      const stored = readStoredCycle()
      const pick =
        stored === ALL || res.data.some((c) => c.id === stored)
          ? stored
          : (res.data.find((c) => c.stage === 'trim') ?? res.data.find((c) => c.stage === 'dry') ?? res.data[0])?.id ??
            ALL
      setSelected(pick)
    })()
    return () => {
      live = false
    }
  }, [run])

  useEffect(() => {
    if (selected) void loadBoard(selected)
  }, [selected, loadBoard])

  useRefetchOnFocus(() => {
    if (selected) void loadBoard(selected)
  })

  function choose(key: string) {
    setSelected(key)
    setBoard(null)
    try {
      window.localStorage.setItem(CYCLE_KEY, key)
    } catch {
      // The pick just won't be remembered.
    }
  }

  const cycle = cycles?.find((c) => c.id === selected) ?? null

  if (cycles === null || (selected === null && !error)) {
    return <p className="py-12 text-center text-muted-foreground">Loading...</p>
  }

  return (
    <div className="space-y-5">
      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-2">
        {access.canOperate && (
          <Button asChild className="h-12 text-base font-semibold">
            <Link href={`${BASE}/station`}>
              <ScanLine className="mr-2 h-5 w-5" />
              Open the trim station
            </Link>
          </Button>
        )}
        <Button asChild variant="outline" className="h-12 text-base font-semibold">
          <Link href={`${BASE}/lookup`}>
            <Search className="mr-2 h-5 w-5" />
            Look up a tag
          </Link>
        </Button>
      </div>

      {/* Cycle selector */}
      <section aria-label="Cycle" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">Cycle</p>
          <Button
            type="button"
            variant="outline"
            className="h-12"
            disabled={refreshing || !selected}
            onClick={() => selected && void loadBoard(selected, true)}
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
          {cycles.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={selected === c.id}
              onClick={() => choose(c.id)}
              className={cn(
                'min-h-12 shrink-0 rounded-lg border-2 px-4 py-2 text-left transition-colors',
                selected === c.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'
              )}
            >
              <span className="block font-semibold">{cycleLabel(c)}</span>
              <span className="block text-xs capitalize opacity-80">{c.stage}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={selected === ALL}
            onClick={() => choose(ALL)}
            className={cn(
              'min-h-12 shrink-0 rounded-lg border-2 px-4 py-2 text-left transition-colors',
              selected === ALL ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'
            )}
          >
            <span className="block font-semibold">All open work</span>
            <span className="block text-xs opacity-80">Every cycle</span>
          </button>
        </div>
        {cycle && (
          <p className="text-sm text-muted-foreground">
            Harvest {dateOnlyText(cycle.harvestDate)} &middot; dry from {dateOnlyText(cycle.dryStart)} &middot; trim from{' '}
            {dateOnlyText(cycle.trimStart)}
          </p>
        )}
        {cycles.length === 0 && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            No cycle is in flower, harvest, dry or trim. Open work from any older cycle still shows under All open work.
          </p>
        )}
      </section>

      {error && !board && (
        <ErrorState title="Could not load the board" message={error} onRetry={() => selected && void loadBoard(selected, true)} />
      )}

      {!board && !error && <p className="py-8 text-center text-muted-foreground">Loading the board...</p>}

      {board && (
        <>
          <section aria-label="Batches" className="space-y-3">
            <h2 className="text-lg font-semibold">Batches</h2>
            {board.batches.length === 0 ? (
              <Card>
                <CardContent className="py-6 text-center text-muted-foreground">
                  {board.scope === 'cycle' ? (
                    <>
                      No batches are declared on this cycle yet.
                      {access.canWeigh && (
                        <>
                          {' '}
                          <Link href={`${BASE}/harvest`} className="underline underline-offset-2">
                            Declare them on the Harvest tab.
                          </Link>
                        </>
                      )}
                    </>
                  ) : (
                    'No open work. Every hanger is finished.'
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {board.batches.map((b) => (
                  <BatchCard key={b.id} batch={b} />
                ))}
              </div>
            )}
          </section>

          {board.partial.length > 0 && (
            <section aria-label="Unfinished hangers" className="space-y-3">
              <h2 className="text-lg font-semibold">
                Waiting to be reissued{' '}
                <span className="text-base font-normal text-muted-foreground">({board.partial.length})</span>
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {board.partial.map((p) => (
                  <Link
                    key={p.loadId}
                    href={`${access.canOperate ? `${BASE}/station` : `${BASE}/lookup`}?code=${encodeURIComponent(p.hangerCode)}`}
                    className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-violet-500/40 bg-violet-500/5 p-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-base font-bold">{p.hangerCode}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {plantsText(p.remainingPlants)} left &middot; {lbText(p.remainingG)} &middot; {p.batchName}
                      </p>
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section aria-label="Trimmers" className="space-y-3">
            <h2 className="text-lg font-semibold">Hangers out with trimmers</h2>
            <TrimmersOut board={board} canOperate={access.canOperate} />
          </section>
        </>
      )}
    </div>
  )
}

function BatchCard({ batch }: { batch: BoardBatch }) {
  const flagged = batch.counts.returned ?? 0
  return (
    <Link
      href={`${BASE}/batches/${batch.id}`}
      className={cn(
        'block rounded-xl border-2 bg-card transition-colors hover:bg-muted/40',
        flagged > 0 ? 'border-red-500/60' : 'border-border'
      )}
    >
      <div className="flex items-center justify-between gap-2 rounded-t-[10px] border-b bg-muted/50 px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-lg font-bold leading-tight">{batch.strainName ?? 'Unknown strain'}</p>
          <p className="truncate text-sm text-muted-foreground">{batch.name}</p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0" />
      </div>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {LOAD_STATUS_ORDER.filter((s) => (batch.counts[s] ?? 0) > 0).map((s) => (
            <span
              key={s}
              className={cn('rounded-full border px-2.5 py-1 text-sm font-semibold', LOAD_STATUS_META[s].pill)}
            >
              {batch.counts[s]} {LOAD_STATUS_META[s].label.split(',')[0].toLowerCase()}
            </span>
          ))}
          {batch.loads === 0 && <span className="text-sm text-muted-foreground">No hangers yet</span>}
        </div>
        {batch.loads > 0 && (
          <dl className="grid grid-cols-4 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Hangers</dt>
              <dd className="font-semibold">{batch.loads}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Plants</dt>
              <dd className="font-semibold">{batch.plants || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Dry</dt>
              <dd className="font-semibold">{batch.dryG > 0 ? lbText(batch.dryG, 1) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Left</dt>
              <dd className="font-semibold">{batch.remainingG > 0 ? lbText(batch.remainingG, 1) : '—'}</dd>
            </div>
          </dl>
        )}
      </div>
    </Link>
  )
}

function TrimmersOut({ board, canOperate }: { board: TrimBoard; canOperate: boolean }) {
  const holding = board.trimmers.filter((t) => t.hangersOut > 0)
  const idle = board.trimmers.length - holding.length
  if (holding.length === 0) {
    return (
      <Card>
        <CardContent className="py-5 text-center text-muted-foreground">
          No hangers are out with a trimmer{board.scope === 'cycle' ? ' for this cycle' : ''}.
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {holding.map((t) => {
          const out = board.out.filter((o) => o.trimmerId === t.id)
          return (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-2 text-lg">
                  <Link href={`${BASE}/staff/${t.id}`} className="truncate underline-offset-2 hover:underline">
                    {t.name}
                  </Link>
                  <span className="shrink-0 text-base font-semibold">
                    {t.hangersOut} {t.hangersOut === 1 ? 'hanger' : 'hangers'} &middot; {lbText(t.gramsOut, 1)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {out.map((o) => (
                    <Link
                      key={o.checkoutId}
                      href={`${canOperate ? `${BASE}/station` : `${BASE}/lookup`}?code=${encodeURIComponent(o.hangerCode)}`}
                      className="flex min-h-12 flex-col justify-center rounded-lg border-2 border-amber-500/50 bg-amber-500/10 px-3"
                    >
                      <span className="font-mono text-base font-bold leading-none">{o.hangerCode}</span>
                      <span className="text-xs text-muted-foreground">{agoText(o.checkedOutAt)}</span>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
      {idle > 0 && (
        <p className="text-sm text-muted-foreground">
          {idle} other active {idle === 1 ? 'trimmer has' : 'trimmers have'} nothing out.
        </p>
      )}
    </div>
  )
}
