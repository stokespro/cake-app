'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, History, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { lookupHanger, type HangerLookup, type ScanLoad } from '@/actions/hangers'
import { reopenLoad } from '@/actions/harvest-trim'
import { BatchBanner } from './batch-banner'
import { EpisodeList } from './episode-list'
import {
  HANGER_STATUS_META,
  LOAD_STATUS_META,
  agoText,
  eventLabel,
  payloadSummary,
  plantsText,
  whenText,
} from './format'
import { Mass } from './mass'
import { ReasonDialog } from './reason-dialog'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'

/** The plain-words answer to "what is this tag right now?" for every possible state. */
function statusSentence(lookup: HangerLookup): string {
  const { hanger, loads, checkout } = lookup
  const latest = loads[0] ?? null

  if (hanger.status === 'retired') return 'This hanger is retired. It is out of service and cannot take new loads.'
  if (hanger.status === 'lost') return 'This hanger is marked lost. It cannot take new loads.'
  if (!latest) return 'This tag has never been used. It is registered and ready for its first load.'

  switch (latest.status) {
    case 'hung':
      return 'Hung wet. It still needs a dry weight before it can be issued.'
    case 'dried':
      return 'Dried and weighed. Ready to hand to a trimmer.'
    case 'checked_out':
      return checkout
        ? `With ${checkout.trimmerName} since ${whenText(checkout.checkedOutAt)} (${agoText(checkout.checkedOutAt)}).`
        : 'Checked out to a trimmer.'
    case 'partial':
      return `Unfinished: ${plantsText(latest.remainingPlantCount)} still on it. Ready to reissue to the same or a different trimmer.`
    case 'returned':
      return 'Came back with a flagged variance. It cannot be reissued until someone resolves it.'
    case 'reconciled':
      return `Finished and reconciled${latest.reconciledAt ? ` on ${whenText(latest.reconciledAt)}` : ''}. Free for a new load.`
    case 'void':
      return `Last load was voided${latest.voidReason ? `: ${latest.voidReason}` : ''}. Free for a new load.`
  }
}

function WeightChain({ load }: { load: ScanLoad }) {
  const steps: Array<{ label: string; g: number | null }> = [
    { label: 'Wet', g: load.wetG },
    { label: 'Dry', g: load.dryG },
    { label: 'Left on hanger', g: load.status === 'reconciled' || load.status === 'void' ? null : load.remainingG },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />}
          <div>
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <Mass g={s.g} stacked />
          </div>
        </div>
      ))}
    </div>
  )
}

function LoadSection({
  load,
  index,
  canReopen,
  onReopen,
}: {
  load: ScanLoad
  index: number
  canReopen: boolean
  onReopen: (load: ScanLoad) => void
}) {
  const meta = LOAD_STATUS_META[load.status]
  return (
    <details open={index === 0} className="group rounded-lg border bg-card">
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', meta.pill)}>{meta.label}</span>
        <span className="text-base font-semibold">{load.batch?.name ?? 'No batch'}</span>
        <span className="text-sm text-muted-foreground">
          {load.batch?.strainName ? `${load.batch.strainName} · ` : ''}
          {whenText(load.createdAt)}
        </span>
      </summary>
      <div className="space-y-4 border-t px-4 py-4">
        <BatchBanner batch={load.batch} />
        {load.batch && (
          <Button asChild variant="outline" className="h-14">
            <Link href={`${BASE}/batches/${load.batch.id}`}>Open batch</Link>
          </Button>
        )}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div>
            <p className="text-xs text-muted-foreground">Plants</p>
            <p className="font-semibold">{load.plantCount ?? '—'}</p>
          </div>
          <WeightChain load={load} />
          <div>
            <p className="text-xs text-muted-foreground">Entered</p>
            <p className="text-sm">{load.source === 'harvest' ? 'At harvest' : 'Late entry at the trim station'}</p>
          </div>
        </div>
        {load.status === 'void' && (
          <p className="rounded-md border border-zinc-500/40 bg-zinc-500/10 p-3 text-sm">
            Voided {whenText(load.voidedAt)}
            {load.voidReason ? `: ${load.voidReason}` : '.'}
          </p>
        )}
        <div>
          <p className="mb-2 text-sm font-semibold">Who held it</p>
          <EpisodeList episodes={load.episodes} />
        </div>
        {canReopen && load.status === 'reconciled' && (
          <Button type="button" variant="outline" className="h-14" onClick={() => onReopen(load)}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reopen this load
          </Button>
        )}
      </div>
    </details>
  )
}

interface HangerDetailPanelProps {
  lookup: HangerLookup
  /** Called after something changed so the owner can refetch. */
  onChanged?: () => void
  /** Offer a deep link into the trim station for this tag. */
  showStationLink?: boolean
}

/**
 * THE hanger-detail view (R2.9b). Lookup, the station's history drawer and the
 * batch page all render this, so there is one answer to "what is this tag?".
 * It answers for every state: never used, mid-trim, reconciled, void, retired.
 */
export function HangerDetailPanel({ lookup, onChanged, showStationLink = true }: HangerDetailPanelProps) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [reopenTarget, setReopenTarget] = useState<ScanLoad | null>(null)

  const { hanger, loads, events } = lookup
  const hangerMeta = HANGER_STATUS_META[hanger.status]
  const latest = loads[0] ?? null
  const latestMeta = latest ? LOAD_STATUS_META[latest.status] : null

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono text-4xl font-bold tracking-tight">{hanger.code}</p>
            <span className={cn('rounded-full border px-3 py-1 text-sm font-semibold', hangerMeta.pill)}>
              {hangerMeta.label}
            </span>
            {latestMeta && (
              <span className={cn('rounded-full border px-3 py-1 text-sm font-semibold', latestMeta.pill)}>
                {latestMeta.label}
              </span>
            )}
          </div>
          <p className="text-lg">{statusSentence(lookup)}</p>
          {hanger.notes && <p className="text-sm text-muted-foreground">Note: {hanger.notes}</p>}
          <p className="text-sm text-muted-foreground">
            {lookup.canStartLoad
              ? 'Free: a new load can be started on this tag.'
              : hanger.status !== 'active'
                ? 'Not available for new loads.'
                : 'In use: finish or close the open load before starting another.'}
          </p>
          {showStationLink && access.canOperate && hanger.status !== 'lost' && (
            <Button asChild className="h-14 text-base font-semibold">
              <Link href={`${BASE}/station?code=${encodeURIComponent(hanger.code)}`}>Open at the trim station</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {loads.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            No loads yet. Once this tag is weighed at harvest or entered at the trim station, its whole history appears
            here.
          </CardContent>
        </Card>
      ) : (
        <section aria-label="Loads" className="space-y-2">
          <h3 className="text-lg font-semibold">
            Loads <span className="text-sm font-normal text-muted-foreground">({loads.length}, newest first)</span>
          </h3>
          {loads.map((load, i) => (
            <LoadSection
              key={load.id}
              load={load}
              index={i}
              canReopen={access.isAdmin && i === 0}
              onReopen={setReopenTarget}
            />
          ))}
        </section>
      )}

      <section aria-label="Audit trail">
        <details className="rounded-lg border bg-card">
          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 px-4 py-3 text-lg font-semibold [&::-webkit-details-marker]:hidden">
            <History className="h-5 w-5" />
            Audit trail
            <span className="text-sm font-normal text-muted-foreground">({events.length})</span>
          </summary>
          <div className="border-t px-4 py-3">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been recorded for this tag yet.</p>
            ) : (
              <ol className="space-y-3">
                {events.map((e) => {
                  const summary = payloadSummary(e.payload)
                  return (
                    <li key={e.id} className="border-l-2 pl-3 text-sm">
                      <p className="font-medium">{eventLabel(e.eventType)}</p>
                      <p className="text-xs text-muted-foreground">
                        {whenText(e.occurredAt)}
                        {e.actorName ? ` · ${e.actorName}` : ''}
                      </p>
                      {summary && <p className="mt-0.5 break-words text-muted-foreground">{summary}</p>}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </details>
      </section>

      <ReasonDialog
        open={reopenTarget !== null}
        onOpenChange={(o) => !o && setReopenTarget(null)}
        title="Reopen this load?"
        description="Puts the load back into review so the weights can be corrected. This is logged."
        chips={['Wrong weight entered', 'Wrong trimmer', 'Other']}
        confirmLabel="Reopen load"
        onConfirm={async (reason) => {
          if (!reopenTarget) return false
          const res = await run(reopenLoad({ loadId: reopenTarget.id, reason }))
          if (res.success) {
            toast.success('Load reopened')
            onChanged?.()
          }
          return res.success
        }}
      />
    </div>
  )
}

// ─── Self-fetching variants ──────────────────────────────────────────────────

interface HangerDetailProps {
  code: string
  showStationLink?: boolean
}

/** Fetches lookupHanger(code) and renders the panel. */
export function HangerDetail({ code, showStationLink }: HangerDetailProps) {
  const run = useTrimRun()
  const [lookup, setLookup] = useState<HangerLookup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const res = await run(lookupHanger(code, 'typed'), { quiet: true })
    if (res.success) {
      setLookup(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoading(false)
  }, [code, run])

  useEffect(() => {
    setLoading(true)
    setLookup(null)
    void load()
  }, [load])

  if (loading) return <p className="py-8 text-center text-muted-foreground">Loading {code}...</p>
  if (error || !lookup) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/30 p-4 text-center">
        <p className="text-destructive">{error ?? 'Could not load this hanger.'}</p>
        <Button variant="outline" className="h-14" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    )
  }
  return <HangerDetailPanel lookup={lookup} onChanged={() => void load()} showStationLink={showStationLink} />
}

interface HangerDetailSheetProps {
  /** null = closed. */
  code: string | null
  onOpenChange: (open: boolean) => void
}

/** The same panel as a drawer, for the station and batch pages. */
export function HangerDetailSheet({ code, onOpenChange }: HangerDetailSheetProps) {
  return (
    <Sheet open={code !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[92vh] md:ml-auto md:h-full md:max-h-none md:max-w-xl md:[--radix-sheet-content-transform:translateX(100%)]"
      >
        <SheetHeader className="pb-4">
          <SheetTitle>{code ?? 'Hanger'}</SheetTitle>
          <SheetDescription>Everything recorded for this tag.</SheetDescription>
        </SheetHeader>
        {code && <HangerDetail code={code} />}
      </SheetContent>
    </Sheet>
  )
}
