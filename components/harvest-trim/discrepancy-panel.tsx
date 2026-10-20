'use client'

import { useState } from 'react'
import { AlertOctagon, Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReturnKind } from '@/types/harvest-trim'
import { BucketBar, type VarianceView } from './variance-banner'
import { gramsText, lbText, pctText, signedGramsText } from './format'
import { ReasonPicker, reasonIsValid } from './reason-picker'

export const ACCEPT_REASON_CHIPS = ['Moisture loss', 'Scale error', 'Spillage', 'Other'] as const

interface DiscrepancyPanelProps {
  hangerCode: string
  trimmerName: string
  kind: ReturnKind
  view: VarianceView
  busy: boolean
  /** Back to the weight fields with every value preserved. */
  onReweigh: () => void
  /** Accept the variance with a written reason. */
  onAccept: (reason: string) => void
  /** Submit as flagged (or just dismiss, if it is already recorded). */
  onLeaveFlagged: () => void
  /** Finished was tapped by mistake: convert to the unfinished flow, keeping the weights. */
  onPlantsStillOn?: () => void
  leaveLabel?: string
}

/**
 * The full-screen red stop. It appears BEFORE a flagged check-in completes
 * (and again when someone scans a hanger that is sitting flagged), and shows
 * issued / returned / variance in grams and percent, the threshold in force and
 * where the weight went. Nothing is hidden behind a tap: the person must choose
 * Re-weigh, Accept with a reason, or Leave flagged.
 */
export function DiscrepancyPanel({
  hangerCode,
  trimmerName,
  kind,
  view,
  busy,
  onReweigh,
  onAccept,
  onLeaveFlagged,
  onPlantsStillOn,
  leaveLabel = 'Leave flagged',
}: DiscrepancyPanelProps) {
  const [accepting, setAccepting] = useState(false)
  const [reason, setReason] = useState('')
  const over = view.direction === 'gain'
  const missingG = Math.abs(view.varianceG)

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`${hangerCode} variance flagged`}
      className="fixed inset-0 z-[70] overflow-y-auto bg-red-700 text-white"
    >
      <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-5 px-4 py-6">
        <div className="flex items-start gap-3">
          <AlertOctagon className="mt-1 h-10 w-10 shrink-0" />
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide opacity-90">
              {hangerCode} &middot; {trimmerName}
            </p>
            <h2 className="text-2xl font-extrabold leading-tight">
              {over ? 'Returned MORE than issued' : 'The weights do not add up'}
            </h2>
            {over ? (
              <p className="mt-1 text-base font-medium">Check the scale, the bin tare, or whether this is the wrong hanger.</p>
            ) : (
              <p className="mt-1 text-base font-medium">
                {lbText(missingG)} ({gramsText(missingG)}) is unaccounted for.
              </p>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-black/25 p-3">
            <dt className="text-xs font-semibold uppercase opacity-80">Issued</dt>
            <dd className="text-lg font-bold">{lbText(view.issuedG)}</dd>
            <dd className="text-sm opacity-90">{gramsText(view.issuedG)}</dd>
          </div>
          <div className="rounded-lg bg-black/25 p-3">
            <dt className="text-xs font-semibold uppercase opacity-80">Returned</dt>
            <dd className="text-lg font-bold">{lbText(view.returnedTotalG + view.remainingG)}</dd>
            <dd className="text-sm opacity-90">{gramsText(view.returnedTotalG + view.remainingG)}</dd>
          </div>
          <div className="rounded-lg bg-white p-3 text-red-700">
            <dt className="text-xs font-semibold uppercase">Variance</dt>
            <dd className="text-2xl font-extrabold">{signedGramsText(-view.varianceG)}</dd>
            <dd className="text-sm font-bold">{pctText(-view.variancePct, 1, true)}</dd>
          </div>
        </dl>

        {view.remainingG > 0 && (
          <p className="text-sm font-medium opacity-95">
            {lbText(view.remainingG)} stayed on the hanger, so the variance is measured against the{' '}
            {lbText(view.processedG)} that was actually worked.
          </p>
        )}

        <div className="rounded-lg bg-white p-4 text-zinc-900">
          <BucketBar v={view} />
        </div>

        <p className="text-base font-medium">
          Threshold in force: flagged above {view.thresholdPct}% <em>and</em> above {gramsText(view.thresholdFloorG)}.
        </p>

        <p className="flex items-start gap-2 rounded-lg border-2 border-white/70 p-3 text-base font-semibold">
          <Scale className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            A flagged hanger cannot be reissued until this is resolved. Pay for it waits too
            {kind === 'unfinished' ? ', and the plants left on it cannot go to another trimmer.' : '.'}
          </span>
        </p>

        {accepting ? (
          <div className="space-y-3 rounded-lg bg-black/25 p-4">
            <ReasonPicker
              id="accept-variance-reason"
              chips={ACCEPT_REASON_CHIPS}
              value={reason}
              onChange={setReason}
              label="Why is this acceptable?"
              tone="onRed"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                className="h-12 bg-white text-base font-semibold text-red-700 hover:bg-white/90"
                disabled={!reasonIsValid(reason) || busy}
                onClick={() => onAccept(reason.trim())}
              >
                {busy ? 'Saving...' : 'Accept this variance'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-12 border-white bg-transparent text-base text-white hover:bg-white/15 hover:text-white"
                disabled={busy}
                onClick={() => setAccepting(false)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <Button
              type="button"
              className="h-12 bg-white text-base font-semibold text-red-700 hover:bg-white/90"
              disabled={busy}
              onClick={onReweigh}
            >
              Re-weigh
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12 border-white bg-transparent text-base font-semibold text-white hover:bg-white/15 hover:text-white"
              disabled={busy}
              onClick={() => setAccepting(true)}
            >
              Accept with reason
            </Button>
            {onPlantsStillOn && kind === 'complete' && (
              <Button
                type="button"
                variant="outline"
                className="h-12 border-white bg-transparent text-base font-semibold text-white hover:bg-white/15 hover:text-white"
                disabled={busy}
                onClick={onPlantsStillOn}
              >
                Plants still on the hanger
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="h-12 text-base font-semibold text-white hover:bg-white/15 hover:text-white"
              disabled={busy}
              onClick={onLeaveFlagged}
            >
              {busy ? 'Saving...' : leaveLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
