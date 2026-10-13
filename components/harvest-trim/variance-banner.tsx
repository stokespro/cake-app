import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VarianceDirection, VarianceEvaluation, VarianceInvalid } from '@/lib/trim/variance'
import { gramsText, lbText, pctText, signedGramsText } from './format'

/** Everything the banner / red panel needs, whether it came from live typing or a stored episode. */
export interface VarianceView {
  issuedG: number
  flowerG: number
  trimG: number
  stemsG: number
  remainingG: number
  processedG: number
  returnedTotalG: number
  varianceG: number
  variancePct: number
  direction: VarianceDirection
  flagged: boolean
  thresholdPct: number
  thresholdFloorG: number
}

export function viewFromEvaluation(
  e: VarianceEvaluation,
  buckets: { flowerG: number; trimG: number; stemsG: number }
): VarianceView {
  return {
    issuedG: e.issuedG,
    flowerG: buckets.flowerG,
    trimG: buckets.trimG,
    stemsG: buckets.stemsG,
    remainingG: e.remainingG,
    processedG: e.processedG,
    returnedTotalG: e.returnedTotalG,
    varianceG: e.varianceG,
    variancePct: e.variancePct,
    direction: e.direction,
    flagged: e.status === 'flagged',
    thresholdPct: e.pctThreshold,
    thresholdFloorG: e.floorG,
  }
}

export function isInvalidEvaluation(e: VarianceEvaluation | VarianceInvalid | null): e is VarianceInvalid {
  return e !== null && e.valid === false
}

const SEGMENTS = [
  { key: 'flowerG', label: 'Flower', bar: 'bg-green-500' },
  { key: 'trimG', label: 'Trim', bar: 'bg-sky-500' },
  { key: 'stemsG', label: 'Stems', bar: 'bg-amber-500' },
  { key: 'remainingG', label: 'Left on hanger', bar: 'bg-violet-500' },
] as const

/**
 * Stacked bar of the four buckets (plus the unaccounted loss in red). Widths
 * are relative to whichever is larger, issued or returned, so an over-return
 * visibly overflows instead of being clipped.
 */
export function BucketBar({ v, onDark = false }: { v: VarianceView; onDark?: boolean }) {
  const loss = v.varianceG > 0 ? v.varianceG : 0
  const total = Math.max(v.flowerG + v.trimG + v.stemsG + v.remainingG + loss, 0.01)
  const parts = SEGMENTS.map((s) => ({ ...s, g: v[s.key] }))

  return (
    <div className="space-y-2">
      <div
        className={cn('flex h-8 w-full overflow-hidden rounded-md', onDark ? 'bg-white/20' : 'bg-muted')}
        role="img"
        aria-label={`Flower ${gramsText(v.flowerG)}, trim ${gramsText(v.trimG)}, stems ${gramsText(v.stemsG)}, left on hanger ${gramsText(v.remainingG)}, missing ${gramsText(loss)}`}
      >
        {parts.map((p) =>
          p.g > 0 ? <div key={p.key} className={p.bar} style={{ width: `${(p.g / total) * 100}%` }} /> : null
        )}
        {loss > 0 && (
          <div
            className="bg-red-500 [background-image:repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(255,255,255,0.35)_6px,rgba(255,255,255,0.35)_12px)]"
            style={{ width: `${(loss / total) * 100}%` }}
          />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {parts
          .filter((p) => p.key !== 'remainingG' || v.remainingG > 0)
          .map((p) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <span className={cn('h-3 w-3 rounded-sm', p.bar)} />
              <span>
                {p.label} {lbText(p.g)}
              </span>
            </li>
          ))}
        {loss > 0 && (
          <li className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-red-500" />
            <span>Missing {lbText(loss)}</span>
          </li>
        )}
      </ul>
    </div>
  )
}

interface VarianceBannerProps {
  view: VarianceView | null
  /** Why there is no figure yet. */
  waitingFor?: string
}

/** Live green / red readout under the check-in fields. The server decides; this is an early look. */
export function VarianceBanner({ view, waitingFor = 'Enter every weight to see the variance.' }: VarianceBannerProps) {
  if (!view) {
    return (
      <div className="rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground">
        {waitingFor}
      </div>
    )
  }
  const Icon = view.flagged ? AlertTriangle : CheckCircle2
  return (
    <div
      aria-live="polite"
      className={cn(
        'space-y-3 rounded-lg border-2 p-4',
        view.flagged
          ? 'border-red-500 bg-red-500/10 text-red-800 dark:text-red-200'
          : 'border-green-500 bg-green-500/10 text-green-800 dark:text-green-200'
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-7 w-7 shrink-0" />
        <div>
          <p className="text-lg font-bold">
            {view.flagged
              ? view.direction === 'gain'
                ? 'More came back than was issued'
                : 'Weights do not add up'
              : 'Within threshold'}
          </p>
          <p className="text-base">
            Variance {signedGramsText(-view.varianceG)} ({pctText(-view.variancePct, 1, true)}) of {lbText(view.processedG)}{' '}
            worked
          </p>
          <p className="text-sm opacity-80">
            Flags above {view.thresholdPct}% and {gramsText(view.thresholdFloorG)}.
          </p>
        </div>
      </div>
      <BucketBar v={view} />
    </div>
  )
}
