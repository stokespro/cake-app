'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import {
  getCycleBatches,
  getTrimBoard,
  listHarvestCycles,
  type CycleBatch,
  type CycleOption,
} from '@/actions/harvest-trim'
import { BatchBanner } from './batch-banner'
import { DeclareBatchesCard } from './declare-batches-card'
import { dateOnlyText } from './format'
import { cycleLabel, eligibleCycles, nextHarvest, pickCycleId, toScanBatch, todayLocal } from './harvest-cycles'
import { HarvestWeighStation, type HarvestTally } from './harvest-weigh-station'
import { LinkBatchCard } from './link-batch-card'
import { NoAccess } from './no-access'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'
const CYCLE_KEY = 'harvest-trim-harvest-cycle'
const BATCH_KEY = 'harvest-trim-harvest-batch'

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // The pick just won't be remembered.
  }
}

/** The pinned batch is remembered with its cycle, so a stale pin from another room is never reused. */
function readStoredBatch(cycleId: string): string | null {
  const raw = readStored(BATCH_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { cycleId?: unknown; batchId?: unknown }
    return v.cycleId === cycleId && typeof v.batchId === 'string' ? v.batchId : null
  } catch {
    return null
  }
}

/** Harvest-day weigh-in: grow, trim managers and admins. */
export function HarvestClient() {
  const access = useTrimAccess()
  if (!access.ready) return null
  if (!access.canWeigh) {
    return (
      <NoAccess
        title="Harvest weigh-in is for the grow and trim team"
        message="Your role can follow progress on the Overview, but not record harvest weights."
        backHref={BASE}
        backLabel="Overview"
      />
    )
  }
  return <Harvest />
}

function Harvest() {
  const access = useTrimAccess()
  const run = useTrimRun()

  const [cycles, setCycles] = useState<{ all: CycleOption[]; today: string } | null>(null)
  const [cycleId, setCycleId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ cycleId: string; list: CycleBatch[] } | null>(null)
  const [tallies, setTallies] = useState<Record<string, HarvestTally>>({})
  const [batchId, setBatchId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cycleRef = useRef<string | null>(null)
  useEffect(() => {
    cycleRef.current = cycleId
  }, [cycleId])

  const eligible = useMemo(() => (cycles ? eligibleCycles(cycles.all, cycles.today) : []), [cycles])
  const cycle = eligible.find((c) => c.id === cycleId) ?? null
  // Batches belong to the cycle they were read for; a different cycle shows nothing until its own arrive.
  const batches = loaded && loaded.cycleId === cycleId ? loaded.list : null

  const loadCycles = useCallback(async () => {
    const res = await run(listHarvestCycles(), { quiet: true })
    if (!res.success) {
      setError(res.error)
      setCycles((prev) => prev ?? { all: [], today: todayLocal() })
      return
    }
    const today = todayLocal()
    setError(null)
    setCycles({ all: res.data, today })
    // Keep the room on screen while it stays weighable; otherwise take the best guess.
    setCycleId((current) => pickCycleId(eligibleCycles(res.data, today), current ?? readStored(CYCLE_KEY)))
  }, [run])

  useEffect(() => {
    void loadCycles()
  }, [loadCycles])

  /** The cycle's batches and, for the tally, what is already weighed into each. */
  const loadBatches = useCallback(
    async (id: string) => {
      const [batchRes, boardRes] = await Promise.all([
        run(getCycleBatches(id), { quiet: true }),
        run(getTrimBoard({ cycleId: id }), { quiet: true }),
      ])
      if (cycleRef.current !== id) return
      if (!batchRes.success) {
        setError(batchRes.error)
        return
      }
      setError(null)
      setLoaded({ cycleId: id, list: batchRes.data })
      if (boardRes.success) {
        setTallies(
          Object.fromEntries(
            boardRes.data.batches.map((b) => [b.id, { hangers: b.loads, plants: b.plants, wetG: b.wetG }])
          )
        )
      }
      // Keep the pin if its batch is still here; otherwise restore the remembered one, or the only one.
      setBatchId((current) => {
        const ids = new Set(batchRes.data.map((b) => b.id))
        if (current && ids.has(current)) return current
        const stored = readStoredBatch(id)
        if (stored && ids.has(stored)) return stored
        return batchRes.data.length === 1 ? batchRes.data[0].id : null
      })
    },
    [run]
  )

  useEffect(() => {
    if (!cycleId) return
    void loadBatches(cycleId)
  }, [cycleId, loadBatches])

  useRefetchOnFocus(() => {
    void loadCycles()
    if (cycleRef.current) void loadBatches(cycleRef.current)
  })

  function chooseCycle(id: string) {
    if (id === cycleId) return
    setBatchId(null)
    setCycleId(id)
    writeStored(CYCLE_KEY, id)
  }

  function pinBatch(id: string | null) {
    setBatchId(id)
    writeStored(BATCH_KEY, id && cycleId ? JSON.stringify({ cycleId, batchId: id }) : null)
  }

  function afterSetup() {
    void loadCycles()
    if (cycleId) void loadBatches(cycleId)
  }

  if (cycles === null) return <p className="py-12 text-center text-muted-foreground">Loading...</p>

  if (error && !cycle) {
    return <ErrorState title="Could not load harvest cycles" message={error} onRetry={() => void loadCycles()} />
  }

  if (eligible.length === 0) {
    const next = nextHarvest(cycles.all, cycles.today)
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="font-medium">No room has reached its harvest date.</p>
          {next && (
            <p className="mt-1 text-sm text-muted-foreground">
              Next: {cycleLabel(next)} on {dateOnlyText(next.harvestDate)}.
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  const pinned = batches?.find((b) => b.id === batchId) ?? null

  return (
    <div className="space-y-4">
      <section aria-label="Cycle" className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Room</p>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
          {eligible.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={cycleId === c.id}
              onClick={() => chooseCycle(c.id)}
              className={cn(
                'min-h-12 shrink-0 rounded-lg border-2 px-4 py-2 text-left transition-colors',
                cycleId === c.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted'
              )}
            >
              <span className="block font-semibold">{cycleLabel(c)}</span>
              <span className="block text-xs opacity-80">Harvest {dateOnlyText(c.harvestDate)}</span>
            </button>
          ))}
        </div>
      </section>

      {cycle && batches === null && !error && <p className="py-8 text-center text-muted-foreground">Loading...</p>}

      {cycle && batches === null && error && (
        <ErrorState title="Could not load batches" message={error} onRetry={() => void loadBatches(cycle.id)} />
      )}

      {cycle && batches !== null && batches.length === 0 && (
        <>
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Declare batches before weighing.</p>
          </div>
          <BatchSetup cycle={cycle} collapsed={false} canLink={access.canOperate} onChanged={afterSetup} />
        </>
      )}

      {cycle && batches !== null && batches.length > 0 && (
        <>
          {pinned ? (
            <>
              <div className="sticky top-0 z-20">
                <BatchBanner batch={toScanBatch(cycle, pinned)} className={batches.length > 1 ? 'pr-24' : undefined} />
                {batches.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="absolute right-3 top-3"
                    onClick={() => pinBatch(null)}
                  >
                    Change
                  </Button>
                )}
              </div>
              <HarvestWeighStation
                key={pinned.id}
                batchId={pinned.id}
                batchName={pinned.name}
                tally={tallies[pinned.id] ?? { hangers: pinned.loadCount, plants: 0, wetG: 0 }}
                onRecorded={(totals) => {
                  if (totals) setTallies((prev) => ({ ...prev, [pinned.id]: totals }))
                  else if (cycleId) void loadBatches(cycleId)
                }}
                onChangeBatch={batches.length > 1 ? () => pinBatch(null) : null}
              />
            </>
          ) : (
            <section aria-label="Batch" className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Which batch are you weighing?</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {batches.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => pinBatch(b.id)}
                    className="flex min-h-12 items-center rounded-lg border-2 border-border px-3 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <span>
                      <span className="block text-base font-semibold">{b.strainName ?? 'Unknown strain'}</span>
                      <span className="block text-sm text-muted-foreground">
                        {b.name} &middot; {tallies[b.id]?.hangers ?? b.loadCount}{' '}
                        {(tallies[b.id]?.hangers ?? b.loadCount) === 1 ? 'hanger' : 'hangers'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <BatchSetup cycle={cycle} collapsed canLink={access.canOperate} onChanged={afterSetup} />
        </>
      )}
    </div>
  )
}

interface BatchSetupProps {
  cycle: CycleOption
  collapsed: boolean
  /** Linking an existing batch is a trim-team action; grow can only declare. */
  canLink: boolean
  onChanged: () => void
}

/** Setting up the cycle's batches: declare the strains coming out of the room, or link an existing batch. */
function BatchSetup({ cycle, collapsed, canLink, onChanged }: BatchSetupProps) {
  return (
    <section aria-label="Set up batches" className="space-y-3">
      <DeclareBatchesCard key={`declare-${cycle.id}`} cycle={cycle} collapsed={collapsed} onDeclared={onChanged} />
      {canLink && (
        <LinkBatchCard key={`link-${cycle.id}`} cycleId={cycle.id} collapsed={collapsed} onLinked={onChanged} />
      )}
    </section>
  )
}
