import { cn } from '@/lib/utils'
import type { ScanEpisode } from '@/actions/hangers'
import { Mass } from './mass'
import { agoText, pctText, plantsText, signedGramsText, whenText } from './format'

function VarianceChip({ ep }: { ep: ScanEpisode }) {
  if (ep.status !== 'returned' || ep.varianceStatus === null) return null
  const label =
    ep.varianceStatus === 'ok' ? 'In threshold' : ep.varianceStatus === 'accepted' ? 'Accepted' : 'Flagged'
  const tone =
    ep.varianceStatus === 'flagged'
      ? 'border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300'
      : ep.varianceStatus === 'accepted'
        ? 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300'
  return (
    <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', tone)}>
      {/* variance_g is issued - returned, so a LOSS is positive in the DB. Every other surface
          (variance-banner, discrepancy-panel, hub, batch report) negates it so a loss reads as
          "-419 g". This chip did not, and showed a loss as "+419 g" on lookup / hanger detail. */}
      {label}: {signedGramsText(ep.varianceG === null ? null : -ep.varianceG)} (
      {pctText(ep.variancePct === null ? null : -ep.variancePct, 1, true)})
    </span>
  )
}

/** One custody episode: who held it, what was issued, and what came back. Never shows a rate. */
export function EpisodeCard({ ep, compact = false }: { ep: ScanEpisode; compact?: boolean }) {
  const returned = ep.status === 'returned'
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold">
          #{ep.seq} {ep.trimmerName}
        </p>
        <span className="text-xs text-muted-foreground">
          {ep.status === 'out'
            ? `Out since ${whenText(ep.checkedOutAt)} (${agoText(ep.checkedOutAt)})`
            : ep.status === 'released'
              ? `Released ${whenText(ep.releasedAt)}`
              : `Returned ${whenText(ep.returnedAt)}`}
        </span>
      </div>

      <p className="mt-1 text-muted-foreground">
        Issued <Mass g={ep.issuedG} />
        {ep.issuedPlantCount !== null && <> &middot; {plantsText(ep.issuedPlantCount)}</>}
        {ep.status !== 'released' && <> &middot; out {whenText(ep.checkedOutAt)}</>}
      </p>

      {ep.status === 'released' && (
        <p className="mt-1">Taken back without being trimmed{ep.releaseReason ? `: ${ep.releaseReason}` : '.'}</p>
      )}

      {returned && (
        <div className="mt-2 space-y-2">
          <p className="font-medium">
            {ep.returnKind === 'unfinished'
              ? `Unfinished: ${plantsText(ep.remainingPlantCount)} left on the hanger`
              : 'Finished'}
            {ep.plantsFinished !== null && ep.returnKind === 'unfinished' && <> ({plantsText(ep.plantsFinished)} done)</>}
          </p>
          {!compact && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Flower</dt>
                <dd><Mass g={ep.flowerG} stacked /></dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Trim</dt>
                <dd><Mass g={ep.trimG} stacked /></dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Stems</dt>
                <dd><Mass g={ep.stemsG} stacked /></dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Left on hanger</dt>
                <dd><Mass g={ep.remainingG ?? 0} stacked /></dd>
              </div>
            </dl>
          )}
          <VarianceChip ep={ep} />
          {ep.varianceReason && <p className="text-muted-foreground">Reason: {ep.varianceReason}</p>}
        </div>
      )}
    </div>
  )
}

export function EpisodeList({ episodes, compact }: { episodes: ScanEpisode[]; compact?: boolean }) {
  if (episodes.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody has held this load yet.</p>
  }
  return (
    <div className="space-y-2">
      {episodes.map((ep) => (
        <EpisodeCard key={ep.id} ep={ep} compact={compact} />
      ))}
    </div>
  )
}
