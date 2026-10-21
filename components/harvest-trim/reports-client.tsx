'use client'

// Trim production report: date x batch x trimmer, with the per-hanger detail.
//
// All filter state lives in the URL (?from=&to=&trimmer=&batch=) so a view is linkable. Absent from/to
// means "today" in America/Chicago, so a bookmark of the bare page is always the current day.
// Days are Chicago calendar days everywhere (lib/trim/day-range.ts), and times are shown in that zone
// too, so the numbers always agree with the day they were filed under.
//
// Variance is shown the way the station shows it (negative = weight missing). The action returns the
// database sign (loss positive); it is flipped here, once, in `shown*`.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  getTrimDayReport,
  listTrimBatchOptions,
  type TrimBatchOption,
  type TrimDayEpisode,
  type TrimDayReport,
  type TrimDayTrimmerRow,
} from '@/actions/trim-reports'
import { listTrimStaff, type TrimStaffRow } from '@/actions/trim-staff'
import { addDays, chicagoClockText, chicagoToday, isValidDay } from '@/lib/trim/day-range'
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

// ─── Filters (URL <-> state) ─────────────────────────────────────────────────

interface Filters {
  from: string
  to: string
  trimmer: string | null
  batch: string | null
}

function readFilters(sp: URLSearchParams, today: string): Filters {
  const rawFrom = sp.get('from')
  const rawTo = sp.get('to')
  const from = isValidDay(rawFrom) ? rawFrom : isValidDay(rawTo) ? rawTo : today
  let to = isValidDay(rawTo) ? rawTo : from
  if (to < from) to = from
  return { from, to, trimmer: sp.get('trimmer') || null, batch: sp.get('batch') || null }
}

function filtersToQuery(f: Filters, today: string): string {
  const q = new URLSearchParams()
  if (!(f.from === today && f.to === today)) {
    q.set('from', f.from)
    q.set('to', f.to)
  }
  if (f.trimmer) q.set('trimmer', f.trimmer)
  if (f.batch) q.set('batch', f.batch)
  const s = q.toString()
  return s ? `?${s}` : ''
}

function presetsFor(today: string): Array<{ label: string; from: string; to: string }> {
  const yesterday = addDays(today, -1)
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: yesterday, to: yesterday },
    { label: 'Last 7 days', from: addDays(today, -6), to: today },
    { label: 'Last 30 days', from: addDays(today, -29), to: today },
  ]
}

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

function OutlierPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      Outlier
    </span>
  )
}

function FlowerShare({ t }: { t: TrimDayTrimmerRow }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="font-semibold">{pctText(t.flowerSharePct, 1)}</span>
      {t.flowerShareDeltaPts !== null && (
        <span className="text-xs text-muted-foreground">
          {t.flowerShareDeltaPts > 0 ? '+' : ''}
          {t.flowerShareDeltaPts.toFixed(1)} pts from the crew
        </span>
      )}
      {t.isFlowerShareOutlier && <OutlierPill />}
    </span>
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

  const today = chicagoToday()
  const filters = useMemo(() => readFilters(new URLSearchParams(searchParams.toString()), today), [searchParams, today])
  const { from, to, trimmer, batch } = filters

  const [report, setReport] = useState<TrimDayReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [staff, setStaff] = useState<TrimStaffRow[]>([])
  const [batches, setBatches] = useState<TrimBatchOption[]>([])
  const requestId = useRef(0)

  const update = useCallback(
    (patch: Partial<Filters>) => {
      const next = { ...filters, ...patch }
      if (next.to < next.from) {
        if (patch.from !== undefined) next.to = next.from
        else next.from = next.to
      }
      router.replace(`${pathname}${filtersToQuery(next, today)}`, { scroll: false })
    },
    [filters, pathname, router, today]
  )

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
  const presets = presetsFor(today)
  const singleDay = from === to
  const selectedTrimmerName = trimmer
    ? (report?.trimmers[0]?.trimmerName ?? staff.find((s) => s.id === trimmer)?.fullName ?? null)
    : null

  return (
    <div className="space-y-5">
      <section aria-label="Filters" className="space-y-3">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Date presets">
          {presets.map((p) => {
            const active = from === p.from && to === p.to
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={active}
                onClick={() => update({ from: p.from, to: p.to })}
                className={cn(
                  'h-12 shrink-0 rounded-lg border-2 px-4 text-sm font-semibold',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
                )}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="report-from">From</Label>
            <Input
              id="report-from"
              type="date"
              value={from}
              max={today}
              onChange={(e) => isValidDay(e.target.value) && update({ from: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to">To</Label>
            <Input
              id="report-to"
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => isValidDay(e.target.value) && update({ to: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-trimmer">Trimmer</Label>
            <Select value={trimmer ?? ALL} onValueChange={(v) => update({ trimmer: v === ALL ? null : v })}>
              <SelectTrigger id="report-trimmer">
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
          <div className="space-y-1">
            <Label htmlFor="report-batch">Batch</Label>
            <Select value={batch ?? ALL} onValueChange={(v) => update({ batch: v === ALL ? null : v })}>
              <SelectTrigger id="report-batch">
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
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {selectedTrimmerName ?? 'All trimmers'} &middot; {singleDay ? dateOnlyText(from) : `${dateOnlyText(from)} to ${dateOnlyText(to)}`}
          {' '}&middot; returns filed by Central Time day
        </p>
      </section>

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
          {/* One trimmer selected: their hangers are what was asked for, so they lead and the crew is context. */}
          {trimmer && <DetailSection report={report} showMoney={showMoney} showDates={!singleDay} />}
          <CrewSection report={report} showMoney={showMoney} onPick={(id) => update({ trimmer: id })} />
          {!trimmer && <DetailSection report={report} showMoney={showMoney} showDates={!singleDay} />}
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

// ─── Crew ────────────────────────────────────────────────────────────────────

function CrewSection({
  report,
  showMoney,
  onPick,
}: {
  report: TrimDayReport
  showMoney: boolean
  onPick: (trimmerId: string) => void
}) {
  const crew = report.crew
  const selected = report.trimmerId

  const nameCell = (t: TrimDayTrimmerRow) => (
    <span className="inline-flex flex-col items-start gap-0.5">
      {selected === t.trimmerId ? (
        <span className="text-base font-semibold">{t.trimmerName}</span>
      ) : (
        <button
          type="button"
          onClick={() => onPick(t.trimmerId)}
          className="min-h-10 text-left text-base font-semibold underline-offset-4 hover:underline"
        >
          {t.trimmerName}
        </button>
      )}
      {t.flaggedReturns > 0 && (
        <span className="text-xs text-muted-foreground">
          {t.flaggedReturns} flagged / accepted
        </span>
      )}
    </span>
  )

  return (
    <section aria-label="Crew" className="space-y-3">
      <h2 className="text-lg font-semibold">
        Crew <span className="text-base font-normal text-muted-foreground">({crew.length})</span>
      </h2>

      {/* Wide screens */}
      <div className="hidden rounded-lg border bg-card lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Trimmer</TableHead>
              <TableHead className="text-right">Hangers</TableHead>
              <TableHead>Flower</TableHead>
              <TableHead>Flower share</TableHead>
              <TableHead className="text-right">Yield</TableHead>
              <TableHead className="text-right">Avg turnaround</TableHead>
              <TableHead>Variance</TableHead>
              {showMoney && <TableHead className="text-right">Pay</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {crew.map((t) => (
              <TableRow
                key={t.trimmerId}
                className={cn(t.isFlowerShareOutlier && 'bg-amber-500/5', selected === t.trimmerId && 'bg-muted')}
              >
                <TableCell className="align-top font-semibold">{t.rank}</TableCell>
                <TableCell className="align-top">{nameCell(t)}</TableCell>
                <TableCell className="text-right align-top">
                  {t.hangers}
                  {t.episodes !== t.hangers && <span className="block text-xs text-muted-foreground">{t.episodes} returns</span>}
                </TableCell>
                <TableCell className="align-top">
                  <Mass g={t.flowerG} stacked />
                </TableCell>
                <TableCell className="align-top">
                  <FlowerShare t={t} />
                </TableCell>
                <TableCell className="text-right align-top font-semibold">{pctText(t.flowerYieldPct, 1)}</TableCell>
                <TableCell className="text-right align-top">{hoursText(t.avgTurnaroundHours)}</TableCell>
                <TableCell className="align-top">
                  <VarianceText g={t.varianceG} pct={t.variancePct} />
                </TableCell>
                {showMoney && <TableCell className="text-right align-top font-semibold">{moneyText(t.payAmount)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Phones and tablets */}
      <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
        {crew.map((t) => (
          <li
            key={t.trimmerId}
            className={cn(
              'space-y-2 rounded-lg border p-3',
              t.isFlowerShareOutlier ? 'border-amber-500/60 bg-amber-500/5' : 'bg-card',
              selected === t.trimmerId && 'border-foreground/40 bg-muted'
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <span className="mt-1 text-sm font-semibold text-muted-foreground">#{t.rank}</span>
                {nameCell(t)}
              </div>
              {showMoney && <span className="text-lg font-semibold">{moneyText(t.payAmount)}</span>}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Hangers</dt>
                <dd className="font-semibold">
                  {t.hangers}
                  {t.episodes !== t.hangers && <span className="text-xs font-normal text-muted-foreground"> ({t.episodes} returns)</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Flower</dt>
                <dd>
                  <Mass g={t.flowerG} stacked />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Yield</dt>
                <dd className="font-semibold">{pctText(t.flowerYieldPct, 1)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Avg turnaround</dt>
                <dd className="font-semibold">{hoursText(t.avgTurnaroundHours)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Variance</dt>
                <dd>
                  <VarianceText g={t.varianceG} pct={t.variancePct} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Flower share</dt>
                <dd>
                  <FlowerShare t={t} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted-foreground">
        {report.baselineFlowerSharePct !== null
          ? `Ranked by flower. Flower share is measured against the crew median of ${pctText(report.baselineFlowerSharePct, 1)}; an outlier is well away from it and worth a look, because moving material from the trim bin to the flower bin raises pay and cannot trip a weight flag.`
          : 'Ranked by flower. Not enough has been returned to set a crew median, so no one is marked as an outlier.'}
        {report.trimmerId && ' The crew is always the whole crew, whichever trimmer is selected.'}
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
  // One trimmer selected: the name is in the heading, so the column is dropped.
  const showTrimmer = !report.trimmerId

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
              {showTrimmer && <TableHead>Trimmer</TableHead>}
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
                {showTrimmer && <TableCell className="align-top">{e.trimmerName}</TableCell>}
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
              {showTrimmer && <span className="text-muted-foreground"> · {e.trimmerName}</span>}
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
