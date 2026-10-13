'use client'

import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { checkOutLoad, correctDryWeight, recordDryWeight } from '@/actions/harvest-trim'
import type { CheckOutResult } from '@/actions/harvest-trim'
import type { ScanLoad } from '@/actions/hangers'
import { checkDryWetRatio } from '@/lib/trim/weights'
import { EpisodeList } from './episode-list'
import { lbText, plantsText } from './format'
import { Mass } from './mass'
import { TrimmerPicker, type PickerTrimmer } from './trimmer-picker'
import { useTrimRun } from './use-trim-run'
import { useWeightFields } from './use-weight-fields'
import { UnitToggle, WeightField } from './weight-field'

const KEYS = ['dry'] as const

interface IssuePanelProps {
  hangerCode: string
  load: ScanLoad
  staff: PickerTrimmer[]
  onIssued: (result: CheckOutResult) => void
  /** Something other than an issue changed (dry weight saved / corrected): re-read the hanger. */
  onChanged: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * Handing a hanger to a trimmer. One panel, three situations decided by the
 * load's status:
 *   hung    - the dry weight is still missing, so it is asked for here;
 *   dried   - dry weight is on file (with a way to correct it);
 *   partial - a reissue: no dry-weight field at all, just what is left.
 */
export function IssuePanel({ hangerCode, load, staff, onIssued, onChanged, onDirtyChange }: IssuePanelProps) {
  const run = useTrimRun()
  const fields = useWeightFields(KEYS)
  const [trimmerId, setTrimmerId] = useState<string | null>(null)
  const [trimmerLabel, setTrimmerLabel] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [busy, setBusy] = useState(false)

  const isHung = load.status === 'hung'
  const isReissue = load.status === 'partial'
  const lastEpisode = load.episodes.length > 0 ? load.episodes[load.episodes.length - 1] : null
  const previousTrimmerId = isReissue ? lastEpisode?.trimmerId ?? null : null

  const dryP = fields.parse('dry')
  const dryWarning = dryP?.ok ? checkDryWetRatio(dryP.grams, load.wetG)?.message ?? null : null

  const dirty = trimmerId !== null || fields.text.dry !== ''
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const issuedG = isHung ? (dryP?.ok ? dryP.grams : null) : isReissue ? load.remainingG : load.dryG
  const hungReady = !isHung || dryP?.ok === true
  const canIssue = trimmerId !== null && hungReady && issuedG !== null && !busy

  async function issue() {
    if (!canIssue || !trimmerId) return
    setBusy(true)
    const res = await run(
      checkOutLoad({
        loadId: load.id,
        trimmerId,
        ...(isHung && dryP?.ok ? { dryG: dryP.grams } : {}),
      })
    )
    setBusy(false)
    if (res.success) onIssued(res.data)
  }

  async function saveDryOnly() {
    if (!dryP?.ok || busy) return
    setBusy(true)
    const call = isHung ? recordDryWeight : correctDryWeight
    const res = await run(call({ loadId: load.id, dryG: dryP.grams }))
    setBusy(false)
    if (res.success) {
      fields.clear('dry')
      setFixing(false)
      onChanged()
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        {isReissue ? (
          <div className="space-y-3">
            <p className="text-xl font-bold">Reissue {hangerCode}</p>
            <p className="rounded-lg border-2 border-violet-500/50 bg-violet-500/10 p-3 text-lg font-semibold">
              {plantsText(load.remainingPlantCount)} left, {lbText(load.remainingG)} remaining{' '}
              <span className="font-normal text-muted-foreground">(was {lbText(load.dryG)} dry)</span>
            </p>
            <div>
              <p className="mb-2 text-sm font-semibold">Earlier trimmers on this hanger</p>
              <EpisodeList episodes={load.episodes.filter((e) => e.status === 'returned')} compact />
            </div>
          </div>
        ) : isHung ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xl font-bold">Dry weight needed</p>
                <p className="text-muted-foreground">
                  Still hung wet{load.wetG !== null && <> &middot; wet was <Mass g={load.wetG} /></>}.
                </p>
              </div>
              <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
            </div>
            <WeightField
              id="issue-dry"
              label="Dry weight (net)"
              unit={fields.unit}
              value={fields.text.dry}
              onChange={(v) => fields.setText('dry', v)}
              parsed={dryP}
              warning={dryWarning}
              note="Zero the scale with the empty hanger first."
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xl font-bold">Issue {hangerCode}</p>
                <p className="text-lg">
                  Dry weight <Mass g={load.dryG} />
                  {load.plantCount !== null && <> &middot; {plantsText(load.plantCount)}</>}
                </p>
              </div>
              <Button type="button" variant="outline" className="h-14" onClick={() => setFixing((f) => !f)}>
                {fixing ? 'Cancel fix' : 'Fix dry weight'}
              </Button>
            </div>
            {fixing && (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex justify-end">
                  <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
                </div>
                <WeightField
                  id="issue-dry-fix"
                  label="Corrected dry weight (net)"
                  unit={fields.unit}
                  value={fields.text.dry}
                  onChange={(v) => fields.setText('dry', v)}
                  parsed={dryP}
                  warning={dryWarning}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-14 w-full text-base font-semibold"
                  disabled={!dryP?.ok || busy}
                  onClick={saveDryOnly}
                >
                  {busy ? 'Saving...' : 'Save corrected dry weight'}
                </Button>
              </div>
            )}
          </div>
        )}

        <TrimmerPicker
          staff={staff}
          selectedId={trimmerId}
          firstId={previousTrimmerId}
          label={isReissue ? 'Who is taking the rest?' : 'Who is trimming this?'}
          onSelect={(id, name) => {
            setTrimmerId(id)
            setTrimmerLabel(name)
          }}
        />

        <div className="sticky bottom-2 z-10 space-y-2 rounded-xl border-2 bg-background p-3 shadow-lg">
          <p className="text-center text-base font-medium" aria-live="polite">
            {hangerCode}
            {issuedG !== null && <> &middot; {lbText(issuedG)}{isReissue ? ' left' : ' dry'}</>}
            {trimmerLabel && (
              <>
                {' '}
                <ArrowRight className="inline h-4 w-4" /> <span className="font-bold">{trimmerLabel}</span>
              </>
            )}
          </p>
          <Button type="button" className="h-16 w-full text-lg font-bold" disabled={!canIssue} onClick={issue}>
            {busy ? 'Issuing...' : trimmerLabel ? `Issue to ${trimmerLabel}` : 'Choose a trimmer'}
          </Button>
          {isHung && (
            <Button
              type="button"
              variant="outline"
              className="h-14 w-full"
              disabled={!dryP?.ok || busy}
              onClick={saveDryOnly}
            >
              Save dry weight only
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
