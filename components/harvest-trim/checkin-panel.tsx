'use client'

import { useEffect, useMemo, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { checkInLoad, correctReturn, releaseCheckout, resolveVariance } from '@/actions/harvest-trim'
import type { ReturnResult } from '@/actions/harvest-trim'
import type { ScanEpisode } from '@/actions/hangers'
import { checkFlowerAgainstIssued } from '@/lib/trim/weights'
import { evaluateVariance, type VarianceEvaluation, type VarianceThresholds } from '@/lib/trim/variance'
import type { HangerLoadStatus, ReturnKind } from '@/types/harvest-trim'
import { DiscrepancyPanel } from './discrepancy-panel'
import { agoText, lbText, plantsText } from './format'
import { Mass } from './mass'
import { PlantStepper } from './plant-stepper'
import { ReasonDialog } from './reason-dialog'
import { VarianceBanner, viewFromEvaluation, type VarianceView } from './variance-banner'
import { UnitToggle, WeightField } from './weight-field'
import { useTrimRun } from './use-trim-run'
import { useWeightFields } from './use-weight-fields'

const FIELD_KEYS = ['flower', 'trim', 'stems', 'remaining'] as const

export interface CheckInDone {
  result: ReturnResult
  /** True when a flagged variance was accepted with a reason. */
  accepted: boolean
  /** Where the load ended up after everything. */
  loadStatus: HangerLoadStatus
}

interface CheckInPanelProps {
  hangerCode: string
  /** The episode being returned (status out) or re-weighed (status returned, mode correct). */
  episode: ScanEpisode
  mode: 'checkin' | 'correct'
  thresholds: VarianceThresholds
  onDone: (done: CheckInDone) => void
  /** Wrong person had it: the hanger was released instead of returned. */
  onReleased: () => void
  onCancel?: () => void
  onDirtyChange: (dirty: boolean) => void
}

/** Weights are net: the crew zeroes the scale with the empty bin on it. There is no tare field anywhere. */
export function CheckInPanel({
  hangerCode,
  episode,
  mode,
  thresholds,
  onDone,
  onReleased,
  onCancel,
  onDirtyChange,
}: CheckInPanelProps) {
  const run = useTrimRun()

  const [kind, setKind] = useState<ReturnKind>(episode.returnKind ?? 'complete')
  const fields = useWeightFields(FIELD_KEYS, {
    flower: mode === 'correct' ? episode.flowerG : null,
    trim: mode === 'correct' ? episode.trimG : null,
    stems: mode === 'correct' ? episode.stemsG : null,
    remaining: mode === 'correct' && episode.returnKind === 'unfinished' ? episode.remainingG : null,
  })
  const [plantsLeft, setPlantsLeft] = useState<number | null>(
    mode === 'correct' && episode.returnKind === 'unfinished' ? episode.remainingPlantCount : null
  )
  const [stage, setStage] = useState<'form' | 'flagged'>('form')
  const [busy, setBusy] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  // Once the server has the return, further saves are corrections of that return.
  const [recorded, setRecorded] = useState<{ key: string; result: ReturnResult } | null>(null)
  const alreadyReturned = mode === 'correct' || recorded !== null

  const flowerP = fields.parse('flower', { allowZero: true })
  const trimP = fields.parse('trim', { allowZero: true })
  const stemsP = fields.parse('stems', { allowZero: true })
  const remainingP = kind === 'unfinished' ? fields.parse('remaining') : null

  const dirty =
    fields.text.flower !== '' ||
    fields.text.trim !== '' ||
    fields.text.stems !== '' ||
    fields.text.remaining !== '' ||
    plantsLeft !== null
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const issuedPlants = episode.issuedPlantCount
  const plantsLeftValid = kind === 'complete' || (plantsLeft !== null && plantsLeft >= 1)

  const weightsReady = !!(
    flowerP?.ok &&
    trimP?.ok &&
    stemsP?.ok &&
    (kind === 'complete' || remainingP?.ok)
  )

  const evaluation: VarianceEvaluation | null = useMemo(() => {
    if (!flowerP?.ok || !trimP?.ok || !stemsP?.ok) return null
    if (kind === 'unfinished' && !remainingP?.ok) return null
    const e = evaluateVariance(
      {
        issuedG: episode.issuedG,
        flowerG: flowerP.grams,
        trimG: trimP.grams,
        stemsG: stemsP.grams,
        remainingG: kind === 'unfinished' && remainingP?.ok ? remainingP.grams : 0,
      },
      thresholds
    )
    return e.valid ? e : null
  }, [flowerP, trimP, stemsP, remainingP, kind, episode.issuedG, thresholds])

  const view: VarianceView | null =
    evaluation && flowerP?.ok && trimP?.ok && stemsP?.ok
      ? viewFromEvaluation(evaluation, { flowerG: flowerP.grams, trimG: trimP.grams, stemsG: stemsP.grams })
      : null

  const invalidEvalMessage = useMemo(() => {
    if (!flowerP?.ok || !trimP?.ok || !stemsP?.ok) return undefined
    if (kind === 'unfinished' && remainingP?.ok) {
      const e = evaluateVariance(
        {
          issuedG: episode.issuedG,
          flowerG: flowerP.grams,
          trimG: trimP.grams,
          stemsG: stemsP.grams,
          remainingG: remainingP.grams,
        },
        thresholds
      )
      if (!e.valid) return e.message
    }
    return undefined
  }, [flowerP, trimP, stemsP, remainingP, kind, episode.issuedG, thresholds])

  const canSubmit = weightsReady && plantsLeftValid && evaluation !== null && !busy

  function inputKey(): string {
    return JSON.stringify([
      kind,
      flowerP?.ok ? flowerP.grams : null,
      trimP?.ok ? trimP.grams : null,
      stemsP?.ok ? stemsP.grams : null,
      kind === 'unfinished' && remainingP?.ok ? remainingP.grams : 0,
      kind === 'unfinished' ? plantsLeft : 0,
    ])
  }

  /** Save the return (or correct it). Returns the server's verdict, or null on failure. */
  async function save(): Promise<ReturnResult | null> {
    if (!canSubmit || !flowerP?.ok || !trimP?.ok || !stemsP?.ok) return null
    const key = inputKey()
    // Same numbers already saved: reuse that verdict instead of writing again.
    if (recorded && recorded.key === key) return recorded.result

    const input = {
      checkoutId: episode.id,
      returnKind: kind,
      flowerG: flowerP.grams,
      trimG: trimP.grams,
      stemsG: stemsP.grams,
      ...(kind === 'unfinished' && remainingP?.ok
        ? { remainingG: remainingP.grams, remainingPlants: plantsLeft ?? undefined }
        : {}),
    }
    const res = await run(alreadyReturned ? correctReturn(input) : checkInLoad(input))
    if (!res.success) return null
    setRecorded({ key, result: res.data })
    return res.data
  }

  async function handleSubmit() {
    if (!canSubmit || !evaluation) return
    // Early look says flagged: show the stop screen before anything is written.
    if (evaluation.status === 'flagged') {
      setStage('flagged')
      return
    }
    setBusy(true)
    const result = await save()
    setBusy(false)
    if (!result) return
    // The server judges with the thresholds as they are right now. If it disagrees, stop and show why.
    if (result.outcome === 'flagged') {
      setStage('flagged')
      return
    }
    onDone({ result, accepted: false, loadStatus: result.loadStatus })
  }

  async function handleLeaveFlagged() {
    setBusy(true)
    const result = await save()
    setBusy(false)
    if (result) onDone({ result, accepted: false, loadStatus: result.loadStatus })
  }

  async function handleAccept(reason: string) {
    setBusy(true)
    const result = await save()
    if (!result) {
      setBusy(false)
      return
    }
    if (result.outcome !== 'flagged') {
      setBusy(false)
      onDone({ result, accepted: false, loadStatus: result.loadStatus })
      return
    }
    const res = await run(resolveVariance({ checkoutId: episode.id, reason }))
    setBusy(false)
    if (res.success) onDone({ result, accepted: true, loadStatus: res.data.loadStatus })
  }

  function handlePlantsStillOn() {
    setKind('unfinished')
    setStage('form')
  }

  const flowerWarning =
    flowerP?.ok ? checkFlowerAgainstIssued(flowerP.grams, episode.issuedG)?.message ?? null : null
  const plantsWarning =
    kind === 'unfinished' && plantsLeft !== null && issuedPlants !== null && plantsLeft === issuedPlants
      ? 'Same number of plants as were issued. Is that right? Partial work on every plant is fine.'
      : null

  if (stage === 'flagged' && view) {
    return (
      <DiscrepancyPanel
        hangerCode={hangerCode}
        trimmerName={episode.trimmerName}
        kind={kind}
        view={view}
        busy={busy}
        onReweigh={() => setStage('form')}
        onAccept={handleAccept}
        onLeaveFlagged={handleLeaveFlagged}
        onPlantsStillOn={handlePlantsStillOn}
      />
    )
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xl font-bold">{mode === 'correct' ? 'Re-weigh the return' : 'Check in'}</p>
            <p className="text-muted-foreground">
              With <span className="font-semibold text-foreground">{episode.trimmerName}</span> &middot; out{' '}
              {agoText(episode.checkedOutAt)}
            </p>
            <p className="mt-1">
              Issued <Mass g={episode.issuedG} />
              {issuedPlants !== null && <> &middot; {plantsText(issuedPlants)}</>}
            </p>
          </div>
          <UnitToggle unit={fields.unit} onChange={fields.setUnit} />
        </div>

        {/* Finished / Unfinished: defaults to Finished so the common case costs no extra taps. */}
        <div role="group" aria-label="Is the hanger finished?" className="grid grid-cols-2 gap-2">
          {(['complete', 'unfinished'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'h-16 rounded-lg border-2 text-lg font-bold transition-colors',
                kind === k
                  ? k === 'complete'
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-violet-600 bg-violet-600 text-white'
                  : 'border-border bg-background hover:bg-muted'
              )}
            >
              {k === 'complete' ? 'Finished' : 'Unfinished'}
            </button>
          ))}
        </div>

        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          Zero the scale with the empty bin on it, then enter <strong>net</strong> weight. There is no tare to type in.
        </p>

        <div className="space-y-5">
          <WeightField
            id="ci-flower"
            label="Flower"
            unit={fields.unit}
            value={fields.text.flower}
            onChange={(v) => fields.setText('flower', v)}
            parsed={flowerP}
            warning={flowerWarning}
            onZero={() => fields.setText('flower', '0')}
          />
          <WeightField
            id="ci-trim"
            label="Trim"
            unit={fields.unit}
            value={fields.text.trim}
            onChange={(v) => fields.setText('trim', v)}
            parsed={trimP}
            onZero={() => fields.setText('trim', '0')}
          />
          <WeightField
            id="ci-stems"
            label="Stems"
            unit={fields.unit}
            value={fields.text.stems}
            onChange={(v) => fields.setText('stems', v)}
            parsed={stemsP}
            onZero={() => fields.setText('stems', '0')}
          />

          {kind === 'unfinished' && (
            <div className="space-y-5 rounded-lg border-2 border-violet-500/50 bg-violet-500/5 p-4">
              <PlantStepper
                id="ci-plants-left"
                label="Plants left"
                value={plantsLeft}
                onChange={setPlantsLeft}
                max={issuedPlants ?? 500}
                note={issuedPlants !== null ? `${plantsText(issuedPlants)} were issued.` : undefined}
                warning={plantsWarning}
              />
              <WeightField
                id="ci-remaining"
                label="Weight of remaining plants"
                unit={fields.unit}
                value={fields.text.remaining}
                onChange={(v) => fields.setText('remaining', v)}
                parsed={remainingP}
                note="Net weight of only the plants still on the hanger."
              />
            </div>
          )}
        </div>

        <VarianceBanner view={view} />
        {invalidEvalMessage && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {invalidEvalMessage}
          </p>
        )}

        <Button
          type="button"
          className="h-16 w-full text-lg font-bold"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {busy
            ? 'Saving...'
            : mode === 'correct'
              ? 'Save corrected weights'
              : kind === 'unfinished'
                ? `Check in, ${plantsLeft ?? '?'} ${plantsLeft === 1 ? 'plant' : 'plants'} left${
                    remainingP?.ok ? ` (${lbText(remainingP.grams)})` : ''
                  }`
                : 'Check in as finished'}
        </Button>

        <div className="flex flex-wrap gap-2">
          {mode === 'correct' && onCancel && (
            <Button type="button" variant="outline" className="h-14" onClick={onCancel} disabled={busy}>
              <Undo2 className="mr-2 h-4 w-4" />
              Back
            </Button>
          )}
          {mode === 'checkin' && !alreadyReturned && (
            <Button type="button" variant="ghost" className="h-14" onClick={() => setReleaseOpen(true)} disabled={busy}>
              Wrong trimmer? Release this hanger
            </Button>
          )}
        </div>
      </CardContent>

      <ReasonDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={`Release ${hangerCode}?`}
        description={`Takes it back from ${episode.trimmerName} without recording any trimming. You can issue it again right away.`}
        chips={['Wrong trimmer', 'Trimmer left', 'Other']}
        confirmLabel="Release hanger"
        onConfirm={async (reason) => {
          const res = await run(releaseCheckout({ checkoutId: episode.id, reason }))
          if (res.success) onReleased()
          return res.success
        }}
      />
    </Card>
  )
}
