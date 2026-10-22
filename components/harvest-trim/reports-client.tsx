'use client'

// Trim production report: totals cards plus the per-hanger table, filtered by date x batch x trimmer.
//
// The date filter is the app's shared <DatePresetFilter> (same control as /dashboard/orders), fed
// TRIM_REPORT_DATE_PRESETS. Presets resolve against America/Chicago's current date, not the device's
// (lib/trim/report-presets.ts), because the action reads the range as Chicago days.
//
// All filter state lives in the URL (?preset=&from=&to=&batch=&trimmer=) so a view is linkable. The bare
// page is "today" in Chicago. Times are shown in that zone too, so the numbers always agree with the day
// they were filed under.
//
// The action also returns a per-trimmer `crew` ranking; this page deliberately does not render it (it is
// groundwork for a trimmer-facing leaderboard, see actions/trim-reports.ts).
//
// Variance is shown the way the station shows it (negative = weight missing). The action returns the
// database sign (loss positive); it is flipped here, once, in `shown*`.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  getTrimDayReport,
  listTrimBatchOptions,
  type TrimBatchOption,
  type TrimDayEpisode,
  type TrimDayReport,
} from '@/actions/trim-reports'
import { listTrimStaff, type TrimStaffRow } from '@/actions/trim-staff'
import { DatePresetFilter } from '@/components/filters/date-preset-filter'
import { TRIM_REPORT_DATE_PRESETS, type DatePresetKey } from '@/lib/date-filters'
import { chicagoClockText, isValidDay } from '@/lib/trim/day-range'
import {
  readTrimReportFilters,
  resolveTrimReportRange,
  trimReportFiltersToQuery,
  type TrimReportFilters,
} from '@/lib/trim/report-presets'
import {
  VARIANCE_LABEL,
  VARIANCE_TONE,
  dateOnlyText,
  gramsText,
  hoursText,
  lbText,
  moneyText,
  pctText,
  signedGramsText,
  trimmerName,
} from './format'
import { Mass } from './mass'
import { Stat } from './stat'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const ALL = 'all'
const DASH = '—'
const LOOKUP = '/dashboard/harvest-trim/lookup'

// ─── Display helpers ─────────────────────────────────────────────────────────

/** Database variance (loss positive) -> the module's display sign (negative = missing). */
function shownVariance(g: number | null): number | null {
  return g === null ? null : -g
}

function varianceNote(g: number): string {
  if (g > 0) return `${gramsText(g)} unaccounted for`
  if (g < 0) return `${gramsText(Math.abs(g))} more than was issued`
  return 'balanced'
}

function VarianceText({ g, pct }: { g: number | null; pct: number | null }) {
  if (g === null) return <span className="text-muted-foreground">{DASH}</span>
  return (
    <span className="inline-flex flex-col items-start leading-tight">
      <span className="font-semibold">{signedGramsText(shownVariance(g))}</span>
      <span className="text-xs text-muted-foreground">{pctText(pct === null ? null : -pct, 1, true)}</span>
    </span>
  )
}

function StatusPill({ status }: { status: TrimDayEpisode['varianceStatus'] }) {
  if (!status) return <span className="text-muted-foreground">{DASH}</span>
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap', VARIANCE_TONE[status])}>
      {VARIANCE_LABEL[status]}
    </span>
  )
}

function HangerLink({ code }: { code: string }) {
  return (
    <Link
      href={`${LOOKUP}?code=${encodeURIComponent(code)}`}
      className="inline-flex min-h-10 items-center whitespace-nowrap font-mono text-base font-bold underline-offset-4 hover:underline"
    >
      {code}
    </Link>
  )
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
  const [staff, setStaff] = useState<TrimStaffRow[]>([])
  const [batches, setBatches] = useState<TrimBatchOption[]>([])
  const requestId = useRef(0)

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

  // Filter options: fetched once. A failure leaves the dropdowns at "All" and does not block the report.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [staffRes, batchRes] = await Promise.all([
        run(listTrimStaff({ includeInactive: true }), { quiet: true }),
        run(listTrimBatchOptions(), { quiet: true }),
      ])
      if (cancelled) return
      if (staffRes.success) setStaff(staffRes.data)
      if (batchRes.success) setBatches(batchRes.data)
    })()
    return () => {
      cancelled = true
    }
  }, [run])

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

  const trimmerOptions = useMemo(
    () => [...staff].sort((a, b) => Number(b.isActive) - Number(a.isActive) || trimmerName(a).localeCompare(trimmerName(b))),
    [staff]
  )
  const showMoney = !!report?.moneyVisible && access.canSeePay
  const singleDay = from === to
  const selectedStaff = trimmer ? staff.find((s) => s.id === trimmer) : undefined
  const selectedTrimmerName = trimmer ? (selectedStaff ? trimmerName(selectedStaff) : (report?.episodes[0]?.trimmerName ?? null)) : null

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-3 pt-6">
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
                {batches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                    {b.strainName ? ` · ${b.strainName}` : ''}
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
                {trimmerOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {trimmerName(s)}
                    {s.isActive ? '' : ' (inactive)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            {selectedTrimmerName ?? 'All trimmers'} &middot; {singleDay ? dateOnlyText(from) : `${dateOnlyText(from)} to ${dateOnlyText(to)}`}
            {' '}&middot; returns filed by Central Time day
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
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          This range has more returns than can be shown at once, so the figures are incomplete. Choose a shorter range for
          exact numbers.
        </p>
      )}

      {report && !error && report.totals.episodes === 0 && (
        <Card className={cn(loading && 'opacity-60')}>
          <CardContent className="py-8 text-center text-muted-foreground">
            No hangers were returned{trimmer || batch ? ' for these filters' : ' in this range'}.
          </CardContent>
        </Card>
      )}

      {report && !error && report.totals.episodes > 0 && (
        <div className={cn('space-y-6', loading && 'opacity-60')}>
          <Summary report={report} showMoney={showMoney} />
          <DetailSection report={report} showMoney={showMoney} showDates={!singleDay} />
        </div>
      )}
    </div>
  )
}

// ─── Summary tiles ───────────────────────────────────────────────────────────

function Summary({ report, showMoney }: { report: TrimDayReport; showMoney: boolean }) {
  const t = report.totals
  return (
    <section aria-label="Totals" className="space-y-3">
      <h2 className="text-lg font-semibold">Totals</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Hangers" sub={`${t.episodes} ${t.episodes === 1 ? 'return' : 'returns'}`}>
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

// ─── Per-hanger detail ───────────────────────────────────────────────────────

function outIn(e: TrimDayEpisode, showDates: boolean): string {
  return `${chicagoClockText(e.checkedOutAt, showDates)} → ${chicagoClockText(e.returnedAt, showDates)}`
}

function Tags({ e }: { e: TrimDayEpisode }) {
  if (e.returnKind !== 'unfinished') return null
  return (
    <span className="inline-block rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
      Unfinished
    </span>
  )
}

function DetailSection({ report, showMoney, showDates }: { report: TrimDayReport; showMoney: boolean; showDates: boolean }) {
  const episodes = report.episodes

  return (
    <section aria-label="Hangers" className="space-y-3">
      <h2 className="text-lg font-semibold">
        Hanger detail <span className="text-base font-normal text-muted-foreground">({episodes.length})</span>
      </h2>

      {/* Wide screens */}
      <div className="hidden rounded-lg border bg-card lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hanger</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Trimmer</TableHead>
              <TableHead>Out → in</TableHead>
              <TableHead className="text-right">Issued</TableHead>
              <TableHead>Flower</TableHead>
              <TableHead className="text-right">Trim</TableHead>
              <TableHead className="text-right">Stems</TableHead>
              <TableHead>Variance</TableHead>
              <TableHead>Status</TableHead>
              {showMoney && <TableHead className="text-right">Pay</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {episodes.map((e) => (
              <TableRow key={e.checkoutId}>
                <TableCell className="align-top">
                  <HangerLink code={e.hangerCode} />
                  {e.seq > 1 && <span className="block text-xs text-muted-foreground">episode {e.seq}</span>}
                  <Tags e={e} />
                </TableCell>
                <TableCell className="align-top whitespace-nowrap">
                  <span className="font-medium">{e.batchName ?? DASH}</span>
                  {e.strainName && <span className="block text-xs text-muted-foreground">{e.strainName}</span>}
                </TableCell>
                <TableCell className="align-top whitespace-nowrap">{e.trimmerName}</TableCell>
                <TableCell className="align-top whitespace-nowrap">
                  {outIn(e, showDates)}
                  <span className="block text-xs text-muted-foreground">{hoursText(e.turnaroundHours)}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.issuedG)}</TableCell>
                <TableCell className="whitespace-nowrap align-top">
                  <Mass g={e.flowerG} stacked />
                </TableCell>
                <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.trimG)}</TableCell>
                <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.stemsG)}</TableCell>
                <TableCell className="whitespace-nowrap align-top">
                  <VarianceText g={e.varianceG} pct={e.variancePct} />
                </TableCell>
                <TableCell className="align-top">
                  <StatusPill status={e.varianceStatus} />
                </TableCell>
                {showMoney && (
                  <TableCell className="whitespace-nowrap text-right align-top">
                    <span className="font-semibold">{moneyText(e.payAmount)}</span>
                    {e.ratePerLb !== null && <span className="block text-xs text-muted-foreground">{moneyText(e.ratePerLb)}/lb</span>}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Phones and tablets */}
      <ul className="space-y-3 lg:hidden">
        {episodes.map((e) => (
          <li key={e.checkoutId} className="space-y-3 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <HangerLink code={e.hangerCode} />
                <Tags e={e} />
              </div>
              <StatusPill status={e.varianceStatus} />
            </div>
            <p className="text-sm">
              <span className="font-medium">{e.batchName ?? DASH}</span>
              {e.strainName && <span className="text-muted-foreground"> · {e.strainName}</span>}
              <span className="text-muted-foreground"> · {e.trimmerName}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              {outIn(e, showDates)} ({hoursText(e.turnaroundHours)})
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Issued</dt>
                <dd className="font-semibold">{gramsText(e.issuedG)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Flower</dt>
                <dd>
                  <Mass g={e.flowerG} stacked />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Trim</dt>
                <dd className="font-semibold">{gramsText(e.trimG)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Stems</dt>
                <dd className="font-semibold">{gramsText(e.stemsG)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Variance</dt>
                <dd>
                  <VarianceText g={e.varianceG} pct={e.variancePct} />
                </dd>
              </div>
              {showMoney && (
                <div>
                  <dt className="text-xs text-muted-foreground">Pay</dt>
                  <dd className="font-semibold">
                    {moneyText(e.payAmount)}
                    {e.ratePerLb !== null && <span className="text-xs font-normal text-muted-foreground"> at {moneyText(e.ratePerLb)}/lb</span>}
                  </dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted-foreground">
        Variance is shown the way the station shows it: negative means weight is missing. Times are Central. Tap a hanger
        for its full history.
      </p>
    </section>
  )
}
