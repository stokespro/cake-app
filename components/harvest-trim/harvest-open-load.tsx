'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { correctWetWeight } from '@/actions/harvest-trim'
import type { ScanLoad, ScanResult } from '@/actions/hangers'
import { LOAD_STATUS_META, agoText, plantsText } from './format'
import { Mass } from './mass'
import { PlantStepper } from './plant-stepper'
import { useTrimRun } from './use-trim-run'
import { useWeightFields } from './use-weight-fields'
import { UnitToggle, WeightField } from './weight-field'

const BASE = '/dashboard/harvest-trim'
const KEYS = ['wet'] as const

interface HarvestOpenLoadProps {
  scan: ScanResult
  load: ScanLoad
  /** The weights changed: re-read the tag. */
  onChanged: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * A scanned tag that already carries a load. Weighing it again would double-count the hanger, so
 * this shows what is on it and, while the weights can still be edited (hung or dried), offers to
 * correct them in place.
 */
export function HarvestOpenLoad({ scan, load, onChanged, onClose, onDirtyChange }: HarvestOpenLoadProps) {
  const [correcting, setCorrecting] = useState(false)
  const meta = LOAD_STATUS_META[load.status]
  const editable = load.status === 'hung' || load.status === 'dried'

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-2xl font-bold tracking-tight">{scan.hanger.code}</p>
          <span className={cn('rounded-full border px-3 py-1 text-sm font-semibold', meta.pill)}>{meta.label}</span>
        </div>
        <p className="font-medium">
          Already weighed{load.batch ? ` into ${load.batch.name}` : ''}.
        </p>
        <dl className="grid grid-cols-3 gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Plants</dt>
            <dd className="font-semibold">{plantsText(load.plantCount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Wet</dt>
            <dd>
              <Mass g={load.wetG} stacked />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Weighed</dt>
            <dd className="font-semibold">{agoText(load.wetRecordedAt ?? load.createdAt)}</dd>
          </div>
        </dl>

        {correcting ? (
          <CorrectionForm
            load={load}
            onSaved={onChanged}
            onCancel={() => setCorrecting(false)}
            onDirtyChange={onDirtyChange}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {editable ? (
              <Button type="button" variant="outline" onClick={() => setCorrecting(true)}>
                Correct this weight
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href={`${BASE}/lookup?code=${encodeURIComponent(scan.hanger.code)}`}>Open in Look up</Link>
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface CorrectionFormProps {
  load: ScanLoad
  onSaved: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
}

function CorrectionForm({ load, onSaved, onCancel, onDirtyChange }: CorrectionFormProps) {
  const run = useTrimRun()
  const fields = useWeightFields(KEYS, { wet: load.wetG })
  const [plants, setPlants] = useState<number | null>(load.plantCount)
  // Only fields the person actually edited are sent: the prefilled weight is rounded to the display
  // unit, so comparing it with the stored grams would call an untouched field "changed".
  const [wetTouched, setWetTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  const wetP = fields.parse('wet')
  const plantsChanged = plants !== null && plants !== load.plantCount
  const wetChanged = wetTouched && !!wetP?.ok
  const valid = (!wetTouched || !!wetP?.ok) && plants !== null
  const canSave = valid && (plantsChanged || wetChanged) && !busy

  const dirty = wetTouched || plantsChanged
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  async function save() {
    if (!canSave) return
    setBusy(true)
    const res = await run(
      correctWetWeight({
        loadId: load.id,
        ...(wetChanged && wetP?.ok ? { wetG: wetP.grams } : {}),
        ...(plantsChanged && plants !== null ? { plantCount: plants } : {}),
      })
    )
    setBusy(false)
    if (res.success) onSaved()
  }

  return (
    <div className="space-y-5 rounded-lg border p-4">
      <div className="flex justify-end">
        <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
      </div>
      <PlantStepper
        id="correct-plants"
        label="Plants"
        value={plants}
        onChange={setPlants}
      />
      <WeightField
        id="correct-wet"
        label="Wet weight"
        unit={fields.unit}
        value={fields.text.wet}
        onChange={(v) => {
          if (fields.setText('wet', v)) setWetTouched(true)
        }}
        parsed={wetP}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          className="flex-1"
          disabled={!canSave}
          onClick={save}
        >
          {busy ? 'Saving...' : 'Save correction'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
