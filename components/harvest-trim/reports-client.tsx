'use client'

// Trim production report: totals cards plus the per-hanger table, filtered by date x batch x trimmer.
//
// The Batch and Trimmer dropdowns are not loaded separately: they come back with the report (batchOptions,
// trimmerOptions), derived server-side from the same rows as the table, so an option with a count can never
// return zero rows. The cascade is one-way, Date -> Batch -> Trimmer (lib/trim/report-options.ts). A selection
// that has nothing is kept and labelled "(0)", never reset; the empty state says whose it is.
//
// The date filter is the app's shared <DatePresetFilter> (same control as /dashboard/orders), fed
// TRIM_REPORT_DATE_PRESETS. Presets resolve against America/Chicago's current date, not the device's
// (lib/trim/report-presets.ts), because the action reads the range as Chicago days.
//
// All filter state lives in the URL (?preset=&from=&to=&batch=&trimmer=) so a view is linkable. The bare
// page is "today" in Chicago. Times are shown in that zone too, so the numbers always agree with the day
// they were filed under.
//
// Hangers still checked out appear in the table but in no figure: totals, yield and pay are over returned
// hangers only, and the open ones are their own "in progress" count (actions/trim-reports.ts).
//
// The action also returns a per-trimmer `crew` ranking; this page deliberately does not render it (it is
// groundwork for a trimmer-facing leaderboard, see actions/trim-reports.ts).
//
// Variance is shown the way the station shows it (negative = weight missing). The action returns the
// database sign (loss positive); it is flipped here, once, in `shownVariance`.
//
// The action pages through PostgREST until the whole range is read, so the totals below cover every return
// in the range. Only if the safety ceiling is genuinely hit does it flag `truncated`, shown as a banner.
// Sorting, subtotals and the column choice are client-side over those rows (report-detail.tsx).
//
// "Finished only" (on by default) is a per-device display preference, like the column choice: localStorage, not
// the URL, and Clear Filters leaves it alone. It hides the open rows from the table and switches the dropdown
// counts to returned-only (so "Antonio (4)" agrees with the Hangers tile); it never reaches the action and never
// moves a total, subtotal or pay figure. Which options exist does not depend on it. "Finished" means the hanger
// is back (status 'returned'); a part-trimmed return (return_kind 'unfinished') is a return and always counts.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getTrimDayReport, type TrimDayReport } from '@/actions/trim-reports'
import { DatePresetFilter } from '@/components/filters/date-preset-filter'
import { TRIM_REPORT_DATE_PRESETS, type DatePresetKey } from '@/lib/date-filters'
import { isValidDay } from '@/lib/trim/day-range'
import { ROW_CEILING } from '@/lib/trim/paging'
import { resolveSort, type SortState, type UserSort } from '@/lib/trim/report-table'
import { batchOptionLabel, emptyReportMessage, optionCount, trimmerOptionLabel } from '@/lib/trim/report-options'
import {
  hasActiveTrimFilters,
  readTrimReportFilters,
  resolveTrimReportRange,
  trimReportFiltersToQuery,
  type TrimReportFilters,
} from '@/lib/trim/report-presets'
import { dateOnlyText, gramsText, lbText, moneyText, pctText, signedGramsText } from './format'
import { ReportDetail, shownVariance } from './report-detail'
import { Stat } from './stat'
import { useFinishedOnly } from './use-finished-only'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const ALL = 'all'

// ─── Display helpers ─────────────────────────────────────────────────────────

function varianceNote(g: number): string {
  if (g > 0) return `${gramsText(g)} unaccounted for`
  if (g < 0) return `${gramsText(Math.abs(g))} more than was issued`
  return 'balanced'
}

// ─── Page ────────────────────────────────────────────────────────────────────

// useSearchParams() requires a Suspense boundary in the App Router.
export function ReportsClient() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-muted-foreground">Loading...</p>}>
      <Reports />
    </Suspense>
  )
}

function Reports() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const access = useTrimAccess()
  const run = useTrimRun()

  const filters = useMemo(() => readTrimReportFilters(new URLSearchParams(searchParams.toString())), [searchParams])
  const { preset, trimmer, batch } = filters
  // Chicago-day range the preset means right now. Plain strings, so `load` below only re-runs on a real change.
  const { from, to } = resolveTrimReportRange(filters)

  const [report, setReport] = useState<TrimDayReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestId = useRef(0)
  const [finishedOnly, setFinishedOnly] = useFinishedOnly()

  // Sorting. The default depends on whether one trimmer is selected (lib/trim/report-table.ts). A click is
  // remembered together with the filters it was made under, so it wins and sticks until a filter changes,
  // with no reset effect to get out of step.
  const filterSig = `${from}|${to}|${batch ?? ''}|${trimmer ?? ''}`
  const [userSort, setUserSort] = useState<UserSort | null>(null)
  const sort = resolveSort(userSort, filterSig, trimmer !== null)
  const changeSort = (next: SortState) => setUserSort({ ...next, filterSig })

  const update = useCallback(
    (patch: Partial<TrimReportFilters>) => {
      const next = { ...filters, ...patch }
      if (next.preset === 'custom' && next.customTo < next.customFrom) {
        if (patch.customFrom !== undefined) next.customTo = next.customFrom
        else next.customFrom = next.customTo
      }
      router.replace(`${pathname}${trimReportFiltersToQuery(next)}`, { scroll: false })
    },
    [filters, pathname, router]
  )

  // <DatePresetFilter> drives these. Entering Custom seeds it with the range on screen (so the inputs are
  // never empty and the component's own device-local "today" seed never applies); leaving Custom makes it
  // clear the inputs, which is ignored here because a preset carries no dates of its own.
  const changePreset = (next: DatePresetKey) =>
    update(next === 'custom' ? { preset: 'custom', customFrom: from, customTo: to } : { preset: next, customFrom: '', customTo: '' })
  const changeCustomFrom = (v: string) => preset === 'custom' && isValidDay(v) && update({ customFrom: v })
  const changeCustomTo = (v: string) => preset === 'custom' && isValidDay(v) && update({ customTo: v })

  // Back to the page's defaults: Today, every batch, every trimmer, no custom dates. That is the bare URL.
  // The column choice and Finished only are display preferences kept in localStorage and are deliberately not touched here.
  const clearFilters = () => router.replace(pathname, { scroll: false })

  const load = useCallback(async () => {
    const mine = ++requestId.current
    setLoading(true)
    const res = await run(
      getTrimDayReport({ from, to, trimmerId: trimmer ?? undefined, batchId: batch ?? undefined }),
      { quiet: true }
    )
    if (mine !== requestId.current) return // a newer filter change superseded this request
    if (res.success) {
      setReport(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoading(false)
  }, [run, from, to, trimmer, batch])

  useEffect(() => {
    void load()
  }, [load])

  const batchOptions = useMemo(() => report?.batchOptions ?? [], [report])
  const trimmerOptions = useMemo(() => report?.trimmerOptions ?? [], [report])
  const showMoney = !!report?.moneyVisible && access.canSeePay
  const singleDay = from === to
  const selectedTrimmerName = trimmer ? (trimmerOptions.find((o) => o.id === trimmer)?.name ?? null) : null
  const hasRows = !!report && report.totals.episodes + report.totals.inProgress > 0

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Filters</CardTitle>
            {hasActiveTrimFilters(filters) && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear Filters
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DatePresetFilter
              value={preset}
              onValueChange={changePreset}
              presets={TRIM_REPORT_DATE_PRESETS}
              customFrom={from}
              customTo={to}
              onCustomFromChange={changeCustomFrom}
              onCustomToChange={changeCustomTo}
              placeholder="Date range"
              idPrefix="trim-report-date"
            />
            <Select value={batch ?? ALL} onValueChange={(v) => update({ batch: v === ALL ? null : v })}>
              <SelectTrigger aria-label="Batch">
                <SelectValue placeholder="All batches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All batches</SelectItem>
                {batch && !batchOptions.some((b) => b.id === batch) && <SelectItem value={batch}>Selected batch</SelectItem>}
                {batchOptions.map((b) => (
                  <SelectItem key={b.id} value={b.id} className={cn(optionCount(b, finishedOnly) === 0 && 'text-muted-foreground')}>
                    {batchOptionLabel(b, finishedOnly)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={trimmer ?? ALL} onValueChange={(v) => update({ trimmer: v === ALL ? null : v })}>
              <SelectTrigger aria-label="Trimmer">
                <SelectValue placeholder="All trimmers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All trimmers</SelectItem>
                {trimmer && !trimmerOptions.some((t) => t.id === trimmer) && <SelectItem value={trimmer}>Selected trimmer</SelectItem>}
                {trimmerOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id} className={cn(optionCount(t, finishedOnly) === 0 && 'text-muted-foreground')}>
                    {trimmerOptionLabel(t, finishedOnly)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            {selectedTrimmerName ?? 'All trimmers'} &middot; {singleDay ? dateOnlyText(from) : `${dateOnlyText(from)} to ${dateOnlyText(to)}`}
            {' '}&middot; returns filed by Central Time day; hangers still out by the day they went out
          </p>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/30">
          <CardContent className="space-y-2 py-5 text-center">
            <p className="text-destructive">{error}</p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {loading && !report && !error && <p className="text-muted-foreground">Loading...</p>}

      {report?.truncated && (
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300"
        >
          This range is too large: it has more than {ROW_CEILING.toLocaleString('en-US')} returns and checked-out hangers, so only the
          first {ROW_CEILING.toLocaleString('en-US')} are included and the totals, filter lists and table below are incomplete. Narrow the
          date range, or pick a batch or trimmer, for exact numbers.
        </p>
      )}

      {report && !error && !hasRows && (
        <Card className={cn(loading && 'opacity-60')}>
          <CardContent className="py-8 text-center text-muted-foreground">
            {emptyReportMessage({ batchId: batch, trimmerId: trimmer, batchOptions, trimmerOptions })}
          </CardContent>
        </Card>
      )}

      {report && !error && hasRows && (
        <div className={cn('space-y-6', loading && 'opacity-60')}>
          <Summary report={report} showMoney={showMoney} />
          <ReportDetail
            episodes={report.episodes}
            showMoney={showMoney}
            showDates={!singleDay}
            sort={sort}
            onSortChange={changeSort}
            resetKey={filterSig}
            finishedOnly={finishedOnly}
            onFinishedOnlyChange={setFinishedOnly}
          />
        </div>
      )}
    </div>
  )
}

// ─── Summary tiles ───────────────────────────────────────────────────────────

function Summary({ report, showMoney }: { report: TrimDayReport; showMoney: boolean }) {
  const t = report.totals
  const inProgress = t.inProgress > 0 ? ` · ${t.inProgress} in progress` : ''
  // Only hangers still out, nothing back yet: there are no figures to total, and zeros would read as "trimmed nothing".
  if (t.episodes === 0) {
    return (
      <section aria-label="Totals" className="space-y-3">
        <h2 className="text-lg font-semibold">Totals</h2>
        <p className="text-sm text-muted-foreground">
          Nothing has been returned yet{inProgress ? `: ${t.inProgress} ${t.inProgress === 1 ? 'hanger is' : 'hangers are'} still checked out` : ''}.
          Totals count returned hangers only.
        </p>
      </section>
    )
  }
  return (
    <section aria-label="Totals" className="space-y-3">
      <h2 className="text-lg font-semibold">Totals</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Hangers" sub={`${t.episodes} ${t.episodes === 1 ? 'return' : 'returns'}${inProgress}`}>
          {t.hangers}
        </Stat>
        <Stat label="Flower" sub={`${gramsText(t.flowerG)} of ${lbText(t.issuedG)} issued`}>
          {lbText(t.flowerG)}
        </Stat>
        <Stat label="Flower yield" sub="flower / issued">
          {pctText(t.flowerYieldPct, 1)}
        </Stat>
        <Stat label="Variance" sub={varianceNote(t.varianceG)}>
          {signedGramsText(shownVariance(t.varianceG))}
        </Stat>
        {showMoney && (
          <Stat label="Pay" sub={t.flaggedReturns > 0 ? `${t.flaggedReturns} flagged, may have no pay line yet` : 'pay lines so far'}>
            {moneyText(t.payAmount)}
          </Stat>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Issued {gramsText(t.issuedG)} &middot; flower {gramsText(t.flowerG)} &middot; trim {gramsText(t.trimG)} &middot; stems{' '}
        {gramsText(t.stemsG)} &middot; flower share of what came back {pctText(t.flowerSharePct, 1)}.
      </p>
    </section>
  )
}
