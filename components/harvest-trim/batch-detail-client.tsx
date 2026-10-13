'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import type { ScanBatch } from '@/actions/hangers'
import { getTrimBoard, listHarvestCycles, type BoardBatch, type TrimBoard } from '@/actions/harvest-trim'
import { getBatchLoads, getBatchYield, type BatchLoadsReport, type YieldBatchReport } from '@/actions/trim-reports'
import { BatchBanner } from './batch-banner'
import { BatchLoadsSection } from './batch-loads-report'
import { agoText, lbText, pctText, plantsText, signedGramsText } from './format'
import { HangerDetailSheet } from './hanger-detail-panel'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'
import { YieldSummaryTable } from './yield-summary'

const BASE = '/dashboard/harvest-trim'

interface BatchData {
  report: YieldBatchReport
  /** Null when the per-hanger read failed on its own: the rest of the page still renders. */
  loads: BatchLoadsReport | null
  loadsError: string | null
  board: TrimBoard | null
  boardBatch: BoardBatch | null
  banner: ScanBatch
}

/**
 * Read-only batch view: where every hanger in the batch stands, the yield, and
 * what needs a decision. There is no close button; closing a batch and approving
 * pay are a later phase.
 */
export function BatchDetailClient({ batchId }: { batchId: string }) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [data, setData] = useState<BatchData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailCode, setDetailCode] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [yieldRes, loadsRes] = await Promise.all([
      run(getBatchYield(batchId), { quiet: true }),
      run(getBatchLoads(batchId), { quiet: true }),
    ])
    if (!yieldRes.success) {
      setError(yieldRes.error)
      return
    }
    const report = yieldRes.data

    const [boardRes, cyclesRes] = report.cycleId
      ? await Promise.all([run(getTrimBoard({ cycleId: report.cycleId }), { quiet: true }), run(listHarvestCycles(), { quiet: true })])
      : [null, null]
    const cycle = cyclesRes?.success ? cyclesRes.data.find((c) => c.id === report.cycleId) : undefined
    const board = boardRes?.success ? boardRes.data : null

    setData({
      report,
      loads: loadsRes.success ? loadsRes.data : null,
      loadsError: loadsRes.success ? null : loadsRes.error,
      board,
      boardBatch: board?.batches.find((b) => b.id === batchId) ?? null,
      banner: {
        id: report.batchId,
        name: report.batchName,
        harvestDate: report.harvestDate,
        strainId: report.strainId,
        strainName: report.strainName,
        cycleId: report.cycleId,
        cycleNumber: cycle?.cycleNumber ?? null,
        cycleStatus: null,
        cycleStage: cycle?.stage ?? null,
        roomName: cycle?.roomName ?? null,
        roomNumber: cycle?.roomNumber ?? null,
      },
    })
    setError(null)
  }, [batchId, run])

  useEffect(() => {
    void load()
  }, [load])
  useRefetchOnFocus(() => void load())

  if (error && !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState title="Could not load this batch" message={error} onRetry={() => void load()} />
      </div>
    )
  }
  if (!data) return <p className="py-12 text-center text-muted-foreground">Loading...</p>

  const { report, board, boardBatch } = data
  const flagged = board?.flagged.filter((f) => f.batchId === batchId) ?? []
  const out = board?.out.filter((o) => o.batchId === batchId) ?? []
  const partial = board?.partial.filter((p) => p.batchId === batchId) ?? []
  const stationHref = (code: string) =>
    `${access.canOperate ? `${BASE}/station` : `${BASE}/lookup`}?code=${encodeURIComponent(code)}`

  return (
    <div className="space-y-5">
      <BackLink />
      <BatchBanner batch={data.banner} />

      <p className="text-base">
        {report.summary.hangers} {report.summary.hangers === 1 ? 'hanger' : 'hangers'}
        {report.openLoads > 0 ? (
          <>
            , <strong>{report.openLoads}</strong> still open
          </>
        ) : report.summary.hangers > 0 ? (
          <>, all finished</>
        ) : null}
        {boardBatch && boardBatch.loads > 0 && <> &middot; {plantsText(boardBatch.plants)}</>}
      </p>

      {/* Needs attention */}
      {(flagged.length > 0 || out.length > 0 || partial.length > 0) && (
        <section aria-label="Needs attention" className="space-y-3">
          <h2 className="text-lg font-semibold">In progress</h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {flagged.map((f) => (
              <li key={f.checkoutId}>
                <Link
                  href={stationHref(f.hangerCode)}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-red-500/60 bg-red-500/10 p-3"
                >
                  <div>
                    <p className="font-mono text-base font-bold">{f.hangerCode}</p>
                    <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                      Flagged &middot; {f.trimmerName} &middot; {signedGramsText(f.varianceG === null ? null : -f.varianceG)} (
                      {pctText(f.variancePct === null ? null : -f.variancePct, 1, true)})
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0" />
                </Link>
              </li>
            ))}
            {partial.map((p) => (
              <li key={p.loadId}>
                <Link
                  href={stationHref(p.hangerCode)}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-violet-500/40 bg-violet-500/5 p-3"
                >
                  <div>
                    <p className="font-mono text-base font-bold">{p.hangerCode}</p>
                    <p className="text-sm text-muted-foreground">
                      Unfinished &middot; {plantsText(p.remainingPlants)} left &middot; {lbText(p.remainingG)}
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0" />
                </Link>
              </li>
            ))}
            {out.map((o) => (
              <li key={o.checkoutId}>
                <Link
                  href={stationHref(o.hangerCode)}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-amber-500/50 bg-amber-500/10 p-3"
                >
                  <div>
                    <p className="font-mono text-base font-bold">{o.hangerCode}</p>
                    <p className="text-sm text-muted-foreground">
                      With {o.trimmerName} &middot; {lbText(o.issuedG)} &middot; {agoText(o.checkedOutAt)}
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Yield and totals */}
      <section aria-label="Totals and yield" className="space-y-3">
        <h2 className="text-lg font-semibold">Totals and yield</h2>
        {report.summary.hangers === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-muted-foreground">
              No hangers have been weighed into this batch yet.
            </CardContent>
          </Card>
        ) : (
          <>
            <YieldSummaryTable summary={report.summary} />
            <p className="text-sm text-muted-foreground">
              Each figure counts only the hangers that have everything it needs, and says how many under it. Void
              hangers are left out.
            </p>
          </>
        )}
      </section>

      {/* Hangers, trimmers and totals */}
      {data.loads ? (
        <BatchLoadsSection
          report={data.loads}
          showMoney={data.loads.moneyVisible && access.canSeePay}
          onOpenHanger={setDetailCode}
        />
      ) : (
        <Card className="border-destructive/30">
          <CardContent className="space-y-2 py-5 text-center">
            <p className="text-destructive">{data.loadsError ?? 'Could not load the hangers for this batch.'}</p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      <HangerDetailSheet code={detailCode} onOpenChange={(o) => !o && setDetailCode(null)} />
    </div>
  )
}

function BackLink() {
  return (
    <Button asChild variant="ghost" className="-ml-3">
      <Link href={BASE}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Overview
      </Link>
    </Button>
  )
}
