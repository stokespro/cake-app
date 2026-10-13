'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  createLateEntryLoad,
  getCycleBatches,
  listHarvestCycles,
  type CycleBatch,
  type CycleOption,
} from '@/actions/harvest-trim'
import type { ScanResult } from '@/actions/hangers'
import { checkDryWetRatio } from '@/lib/trim/weights'
import { cn } from '@/lib/utils'
import { dateOnlyText, plantsText } from './format'
import { PlantStepper } from './plant-stepper'
import { useTrimRun } from './use-trim-run'
import { useWeightFields } from './use-weight-fields'
import { UnitToggle, WeightField } from './weight-field'

const KEYS = ['dry', 'wet'] as const
const STORE_KEY = 'harvest-trim-last-batch'

interface Remembered {
  cycleId: string
  batchId: string
}

function readRemembered(): Remembered | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Remembered>
    return typeof v.cycleId === 'string' && typeof v.batchId === 'string' ? (v as Remembered) : null
  } catch {
    return null
  }
}

function cycleLabel(c: CycleOption): string {
  const room = c.roomName ?? (c.roomNumber !== null ? `Room ${c.roomNumber}` : 'Room')
  return `${room}${c.cycleNumber !== null ? ` · Cycle ${c.cycleNumber}` : ''} · ${c.stage}`
}

interface NewLoadPanelProps {
  scan: ScanResult
  /** The load exists now; re-read the hanger to continue to issuing it. */
  onCreated: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * Start a load on a free hanger from the trim station: the "late entry" path
 * for hangers that were already drying on paper. Only offered when resolveScan
 * says canStartLoad, which is true for a never-used tag AND for one whose last
 * load is finished (nextStep 'closed_out'), never for a retired / lost tag.
 */
export function NewLoadPanel({ scan, onCreated, onDirtyChange }: NewLoadPanelProps) {
  const run = useTrimRun()
  const fields = useWeightFields(KEYS)
  const [cycles, setCycles] = useState<CycleOption[] | null>(null)
  const [cycleId, setCycleId] = useState<string | null>(null)
  const [batches, setBatches] = useState<CycleBatch[] | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const [plants, setPlants] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const last = scan.lastClosedLoad

  useEffect(() => {
    let live = true
    void (async () => {
      const res = await run(listHarvestCycles(), { quiet: true })
      if (!live) return
      if (!res.success) {
        setCycles([])
        return
      }
      setCycles(res.data)
      const remembered = readRemembered()
      const pick =
        res.data.find((c) => c.id === remembered?.cycleId) ??
        res.data.find((c) => c.stage === 'trim' || c.stage === 'dry') ??
        res.data[0] ??
        null
      setCycleId(pick?.id ?? null)
      if (pick && remembered?.cycleId === pick.id) setBatchId(remembered.batchId)
    })()
    return () => {
      live = false
    }
  }, [run])

  const loadBatches = useCallback(
    async (id: string) => {
      setBatches(null)
      const res = await run(getCycleBatches(id), { quiet: true })
      setBatches(res.success ? res.data : [])
    },
    [run]
  )

  useEffect(() => {
    if (cycleId) void loadBatches(cycleId)
    else setBatches(null)
  }, [cycleId, loadBatches])

  const dryP = fields.parse('dry')
  const wetP = fields.parse('wet')
  const dirty = fields.text.dry !== '' || fields.text.wet !== '' || plants !== null
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const wetWarning = dryP?.ok && wetP?.ok ? checkDryWetRatio(dryP.grams, wetP.grams)?.message ?? null : null
  const canCreate = !!(batchId && dryP?.ok && (fields.text.wet === '' || wetP?.ok) && !busy)

  async function create() {
    if (!canCreate || !batchId || !dryP?.ok) return
    setBusy(true)
    const res = await run(
      createLateEntryLoad({
        hangerId: scan.hanger.id,
        batchId,
        dryG: dryP.grams,
        ...(wetP?.ok ? { wetG: wetP.grams } : {}),
        ...(plants !== null ? { plantCount: plants } : {}),
      })
    )
    setBusy(false)
    if (!res.success) return
    try {
      if (cycleId) window.localStorage.setItem(STORE_KEY, JSON.stringify({ cycleId, batchId }))
    } catch {
      // Remembering the batch is a convenience only.
    }
    onCreated()
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div>
          <p className="text-lg font-bold">{scan.hanger.code} {last ? 'has no open load' : 'has no record'}</p>
          <p className="text-muted-foreground">
            {last
              ? last.status === 'void'
                ? 'Its last load was voided. '
                : 'Its last load is finished. '
              : ''}
            Catch it up before it can be issued. Harvest-day weighing is on the Harvest tab.
          </p>
        </div>

        {cycles === null ? (
          <p className="text-muted-foreground">Loading cycles...</p>
        ) : cycles.length === 0 ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 font-medium text-amber-700 dark:text-amber-300">
            No cycle is in flower, harvest, dry or trim right now, so there is nothing to put this hanger in.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Which room and cycle?</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {cycles.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={cycleId === c.id}
                    onClick={() => {
                      setCycleId(c.id)
                      setBatchId(null)
                    }}
                    className={cn(
                      'min-h-12 rounded-lg border-2 px-3 py-2 text-left text-sm font-medium transition-colors',
                      cycleId === c.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted'
                    )}
                  >
                    <span className="block text-base font-semibold">{cycleLabel(c)}</span>
                    <span className="block text-xs opacity-80">Harvest {dateOnlyText(c.harvestDate)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Which batch is it?</p>
              {batches === null ? (
                <p className="text-muted-foreground">Loading batches...</p>
              ) : batches.length === 0 ? (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm font-medium text-amber-700 dark:text-amber-300">
                  No batches are declared on this cycle yet. Link or declare one on the{' '}
                  <Link href="/dashboard/harvest-trim/harvest" className="underline">
                    Harvest
                  </Link>{' '}
                  tab first.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {batches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      aria-pressed={batchId === b.id}
                      onClick={() => setBatchId(b.id)}
                      className={cn(
                        'flex min-h-12 items-center gap-3 rounded-lg border-2 px-3 py-2 text-left transition-colors',
                        batchId === b.id ? 'border-primary ring-2 ring-primary' : 'border-border hover:bg-muted'
                      )}
                    >
                      <span>
                        <span className="block text-base font-semibold">{b.strainName ?? 'Unknown strain'}</span>
                        <span className="block text-sm text-muted-foreground">
                          {b.name} &middot; {b.loadCount} {b.loadCount === 1 ? 'hanger' : 'hangers'}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end">
          <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
        </div>
        <WeightField
          id="new-dry"
          label="Dry weight (net)"
          unit={fields.unit}
          value={fields.text.dry}
          onChange={(v) => fields.setText('dry', v)}
          parsed={dryP}
          note="Zero the scale with the empty hanger first."
        />

        {showMore ? (
          <div className="space-y-5 rounded-lg border p-4">
            <PlantStepper
              id="new-plants"
              label="Plants on the hanger (optional)"
              value={plants}
              onChange={setPlants}
              note={plants !== null ? plantsText(plants) : undefined}
            />
            <WeightField
              id="new-wet"
              label="Wet weight (optional)"
              unit={fields.unit}
              value={fields.text.wet}
              onChange={(v) => fields.setText('wet', v)}
              parsed={wetP}
              warning={wetWarning}
            />
          </div>
        ) : (
          <Button type="button" variant="outline" className="w-full" onClick={() => setShowMore(true)}>
            I also know the plants and wet weight
          </Button>
        )}

        <Button type="button" className="h-14 w-full text-lg font-semibold" disabled={!canCreate} onClick={create}>
          {busy ? 'Creating...' : 'Create load and continue'}
        </Button>
      </CardContent>
    </Card>
  )
}
