'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { addDays, format } from 'date-fns'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getTrimmerPerformance, type TrimmerPerformanceReport } from '@/actions/trim-reports'
import { hoursText, lbText, moneyText, pctText } from './format'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const PRESETS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const

function isoDay(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

/**
 * One trimmer's numbers over a date range. The report is requested for the
 * whole crew and this person's row picked out, because the flower-share outlier
 * check is measured against the crew's median: asking for one person would
 * compare them with themselves.
 */
export function TrimmerPerformance({ trimmerId }: { trimmerId: string }) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [days, setDays] = useState<number | null>(30)
  const [from, setFrom] = useState(() => isoDay(addDays(new Date(), -30)))
  const [to, setTo] = useState(() => isoDay(new Date()))
  const [report, setReport] = useState<TrimmerPerformanceReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await run(getTrimmerPerformance({ from, to }), { quiet: true })
    if (res.success) {
      setReport(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoading(false)
  }, [run, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const row = useMemo(() => report?.rows.find((r) => r.trimmerId === trimmerId) ?? null, [report, trimmerId])

  function preset(d: number) {
    setDays(d)
    setFrom(isoDay(addDays(new Date(), -d)))
    setTo(isoDay(new Date()))
  }

  return (
    <section aria-label="Performance" className="space-y-3">
      <h3 className="text-xl font-semibold">Performance</h3>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            type="button"
            aria-pressed={days === p.days}
            onClick={() => preset(p.days)}
            className={cn(
              'h-14 rounded-lg border-2 px-4 text-base font-semibold',
              days === p.days ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
            )}
          >
            Last {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="perf-from">From</Label>
          <Input
            id="perf-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => {
              setDays(null)
              setFrom(e.target.value)
            }}
            className="h-14 text-base"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="perf-to">To</Label>
          <Input
            id="perf-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              setDays(null)
              setTo(e.target.value)
            }}
            className="h-14 text-base"
          />
        </div>
      </div>

      {error && (
        <Card className="border-destructive/30">
          <CardContent className="space-y-2 py-5 text-center">
            <p className="text-destructive">{error}</p>
            <Button type="button" variant="outline" className="h-14" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {loading && !report && <p className="text-muted-foreground">Loading...</p>}

      {report && !error && !row && (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            No returned hangers in this range.
          </CardContent>
        </Card>
      )}

      {report?.truncated && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          This range has more returns than can be summarised at once. Choose a shorter range for exact figures.
        </p>
      )}

      {row && (
        <div className={cn('space-y-3', loading && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Hangers" value={String(row.hangers)} sub={`${row.episodes} ${row.episodes === 1 ? 'return' : 'returns'}`} />
            <Stat label="Flower" value={lbText(row.flowerG)} />
            <Stat label="Trim" value={lbText(row.trimG)} />
            <Stat label="Stems" value={lbText(row.stemsG)} />
            <Stat label="Worked" value={lbText(row.processedG)} sub="issued minus left on hanger" />
            <Stat label="Avg turnaround" value={hoursText(row.avgTurnaroundHours)} />
            <Stat
              label="Avg variance"
              value={pctText(row.avgVariancePct, 2, true)}
              sub={row.avgAbsVariancePct !== null ? `typical miss ${pctText(row.avgAbsVariancePct, 2)}` : undefined}
            />
            <Stat
              label="Flagged returns"
              value={String(row.flaggedReturns)}
              sub={`${row.acceptedReturns} accepted`}
            />
          </div>

          <div
            className={cn(
              'rounded-lg border-2 p-4',
              row.isFlowerShareOutlier ? 'border-amber-500 bg-amber-500/10' : 'border-border bg-card'
            )}
          >
            <div className="flex items-start gap-3">
              {row.isFlowerShareOutlier && <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />}
              <div>
                <p className="text-xs text-muted-foreground">Flower share of everything returned</p>
                <p className="text-2xl font-bold">{pctText(row.flowerSharePct, 1)}</p>
                <p className="text-sm text-muted-foreground">
                  Crew median {pctText(report?.baselineFlowerSharePct ?? null, 1)}
                  {row.flowerShareDeltaPts !== null && (
                    <>
                      {' '}
                      &middot; {row.flowerShareDeltaPts > 0 ? '+' : ''}
                      {row.flowerShareDeltaPts.toFixed(1)} points from it
                    </>
                  )}
                </p>
                {row.isFlowerShareOutlier && (
                  <p className="mt-1 text-sm font-medium">
                    Well away from the crew. Worth a look: moving material from the trim bin to the flower bin raises pay
                    and cannot trip a weight flag.
                  </p>
                )}
              </div>
            </div>
          </div>

          {access.canSeePay && row.payAmount !== null && (
            <Stat label="Earned in range" value={moneyText(row.payAmount)} />
          )}
        </div>
      )}
    </section>
  )
}
