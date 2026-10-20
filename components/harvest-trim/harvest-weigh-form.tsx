'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { recordHarvestWeight, type HarvestWeightResult } from '@/actions/harvest-trim'
import type { ScanResult } from '@/actions/hangers'
import { PlantStepper } from './plant-stepper'
import { useTrimRun } from './use-trim-run'
import { useWeightFields } from './use-weight-fields'
import { UnitToggle, WeightField } from './weight-field'

const KEYS = ['wet'] as const

export interface HarvestRecorded {
  code: string
  plants: number
  wetG: number
  totals: HarvestWeightResult['batchTotals']
}

interface HarvestWeighFormProps {
  scan: ScanResult
  batchId: string
  onRecorded: (recorded: HarvestRecorded) => void
  /** The batch cannot take weights (BATCH_REQUIRED). */
  onBatchProblem: (message: string) => void
  /** Someone else just put a load on this tag (DUPLICATE_OPEN): show what is on it. */
  onConflict: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * The weigh-in for one hanger: plants, net wet weight, record. The crew tares the hanger, so the
 * number typed is the weight of the plants alone.
 */
export function HarvestWeighForm({
  scan,
  batchId,
  onRecorded,
  onBatchProblem,
  onConflict,
  onCancel,
  onDirtyChange,
}: HarvestWeighFormProps) {
  const run = useTrimRun()
  const fields = useWeightFields(KEYS)
  const [plants, setPlants] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const wetP = fields.parse('wet')
  const dirty = plants !== null || fields.text.wet !== ''
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const canRecord = plants !== null && !!wetP?.ok && !busy

  async function record() {
    if (plants === null || !wetP?.ok || busy) return
    setBusy(true)
    const res = await run(
      recordHarvestWeight({ hangerId: scan.hanger.id, batchId, plantCount: plants, wetG: wetP.grams })
    )
    setBusy(false)
    if (res.success) {
      onRecorded({ code: scan.hanger.code, plants, wetG: res.data.wetG, totals: res.data.batchTotals })
      return
    }
    if (res.code === 'BATCH_REQUIRED') onBatchProblem(res.error)
    else if (res.code === 'DUPLICATE_OPEN') onConflict()
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-2xl font-bold tracking-tight">{scan.hanger.code}</p>
          <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
        </div>

        <PlantStepper id="harvest-plants" label="Plants" value={plants} onChange={setPlants} />

        <WeightField
          id="harvest-wet"
          label="Wet weight"
          unit={fields.unit}
          value={fields.text.wet}
          onChange={(v) => fields.setText('wet', v)}
          parsed={wetP}
          note="Tare the hanger first."
        />

        <div className="space-y-2">
          <Button type="button" className="h-14 w-full text-lg font-semibold" disabled={!canRecord} onClick={record}>
            {busy ? 'Recording...' : 'Record weight'}
          </Button>
          <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
