'use client'

// The per-hanger part of the trim report: a sortable table (with a per-trimmer subtotal row after each
// person's block when sorted by trimmer) on wide screens, and a card list on phones and tablets.
//
// All ordering and arithmetic is in lib/trim/report-table.ts and runs over EVERY episode the report holds.
// This component may render only the first RENDER_STEP hangers (the rest behind "Show more"), but the
// totals cards above and every subtotal here are computed from the whole filtered set, never the rendered
// slice. Which columns show is lib/trim/report-columns.ts; Pay is absent (not hidden) when `showMoney` is false.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpDown, ChevronDown, ChevronUp, Columns3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { TrimDayEpisode } from '@/actions/trim-reports'
import { chicagoClockText } from '@/lib/trim/day-range'
import {
  columnDef,
  resolveVisibleColumns,
  selectableColumns,
  type ReportColumnKey,
} from '@/lib/trim/report-columns'
import {
  buildDisplayItems,
  limitDisplayItems,
  nextSort,
  showsSubtotals,
  sortEpisodes,
  type DisplayItem,
  type SortDirection,
  type SortKey,
  type SortState,
  type TrimmerSubtotal,
} from '@/lib/trim/report-table'
import {
  VARIANCE_LABEL,
  VARIANCE_TONE,
  gramsText,
  hoursText,
  moneyText,
  pctText,
  signedGramsText,
} from './format'
import { Mass } from './mass'
import { useReportColumns } from './use-report-columns'

const DASH = '—'
const LOOKUP = '/dashboard/harvest-trim/lookup'
/** Hangers rendered at first, and added by each "Show more". Totals and subtotals never depend on this. */
export const RENDER_STEP = 250

// ─── Display helpers ─────────────────────────────────────────────────────────

/** Database variance (loss positive) -> the module's display sign (negative = missing). */
export function shownVariance(g: number | null): number | null {
  return g === null ? null : -g
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

function SortIcon({ active, dir }: { active: boolean; dir: SortDirection }) {
  if (!active) return <ArrowUpDown className="ml-1 h-4 w-4 opacity-50" aria-hidden />
  return dir === 'asc' ? <ChevronUp className="ml-1 h-4 w-4" aria-hidden /> : <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
}

// ─── Column selector ─────────────────────────────────────────────────────────

export function ColumnsMenu({
  hidden,
  showMoney,
  onToggle,
  onReset,
}: {
  hidden: readonly ReportColumnKey[]
  showMoney: boolean
  onToggle: (key: ReportColumnKey) => void
  onReset: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Columns3 className="mr-2 h-4 w-4" aria-hidden />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {selectableColumns(showMoney).map((c) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={!c.hideable || !hidden.includes(c.key)}
            disabled={!c.hideable}
            onCheckedChange={() => onToggle(c.key)}
            // Keep the menu open so several columns can be switched in one visit.
            onSelect={(event) => event.preventDefault()}
          >
            {c.label}
            {!c.hideable && <span className="ml-2 text-xs text-muted-foreground">always shown</span>}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>Reset to default</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── Table pieces ────────────────────────────────────────────────────────────

function EpisodeCells({ e, col, showDates }: { e: TrimDayEpisode; col: ReportColumnKey; showDates: boolean }) {
  switch (col) {
    case 'hanger':
      return (
        <TableCell className="align-top">
          <HangerLink code={e.hangerCode} />
          {e.seq > 1 && <span className="block text-xs text-muted-foreground">episode {e.seq}</span>}
          <Tags e={e} />
        </TableCell>
      )
    case 'batch':
      return (
        <TableCell className="align-top whitespace-nowrap">
          <span className="font-medium">{e.batchName ?? DASH}</span>
          {e.strainName && <span className="block text-xs text-muted-foreground">{e.strainName}</span>}
        </TableCell>
      )
    case 'trimmer':
      return <TableCell className="align-top whitespace-nowrap">{e.trimmerName}</TableCell>
    case 'outIn':
      return (
        <TableCell className="align-top whitespace-nowrap">
          {outIn(e, showDates)}
          <span className="block text-xs text-muted-foreground">{hoursText(e.turnaroundHours)}</span>
        </TableCell>
      )
    case 'issued':
      return <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.issuedG)}</TableCell>
    case 'flower':
      return (
        <TableCell className="whitespace-nowrap align-top">
          <Mass g={e.flowerG} stacked />
        </TableCell>
      )
    case 'trim':
      return <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.trimG)}</TableCell>
    case 'stems':
      return <TableCell className="whitespace-nowrap text-right align-top">{gramsText(e.stemsG)}</TableCell>
    case 'variance':
      return (
        <TableCell className="whitespace-nowrap align-top">
          <VarianceText g={e.varianceG} pct={e.variancePct} />
        </TableCell>
      )
    case 'status':
      return (
        <TableCell className="align-top">
          <StatusPill status={e.varianceStatus} />
        </TableCell>
      )
    case 'pay':
      return (
        <TableCell className="whitespace-nowrap text-right align-top">
          <span className="font-semibold">{moneyText(e.payAmount)}</span>
          {e.ratePerLb !== null && <span className="block text-xs text-muted-foreground">{moneyText(e.ratePerLb)}/lb</span>}
        </TableCell>
      )
  }
}

/**
 * A trimmer's rollup row. It is a row of its own with a row header ("Subtotal ... n hangers") so assistive
 * tech announces it as a subtotal, not as another hanger; the cells keep their columns so each figure sits
 * under its header. Only columns that are meaningful to sum are filled in.
 */
function SubtotalRow({ st, columns }: { st: TrimmerSubtotal; columns: readonly ReportColumnKey[] }) {
  const nameShown = columns.includes('trimmer')
  return (
    <TableRow data-subtotal="" className="border-t-2 bg-muted/70 font-semibold hover:bg-muted/70">
      {columns.map((col) => {
        switch (col) {
          case 'hanger':
            return (
              <TableHead key={col} scope="row" className="h-auto py-2 align-top font-semibold text-foreground">
                <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {nameShown ? 'Subtotal' : `${st.trimmerName} subtotal`}
                  {nameShown && <span className="sr-only"> for {st.trimmerName}</span>}
                </span>
                <span className="block whitespace-nowrap">
                  {st.hangers} {st.hangers === 1 ? 'hanger' : 'hangers'}
                </span>
              </TableHead>
            )
          case 'trimmer':
            return (
              <TableCell key={col} className="whitespace-nowrap align-top">
                {st.trimmerName}
              </TableCell>
            )
          case 'issued':
            return (
              <TableCell key={col} className="whitespace-nowrap text-right align-top">
                {gramsText(st.issuedG)}
              </TableCell>
            )
          case 'flower':
            return (
              <TableCell key={col} className="whitespace-nowrap align-top">
                <Mass g={st.flowerG} stacked />
              </TableCell>
            )
          case 'variance':
            return (
              <TableCell key={col} className="whitespace-nowrap align-top">
                {signedGramsText(shownVariance(st.varianceG))}
              </TableCell>
            )
          case 'pay':
            return (
              <TableCell key={col} className="whitespace-nowrap text-right align-top">
                {moneyText(st.payAmount)}
              </TableCell>
            )
          default:
            // Batch, Out -> in, Trim, Stems, Status: not meaningful to sum.
            return <TableCell key={col} className="align-top" />
        }
      })}
    </TableRow>
  )
}

function SubtotalCard({ st, columns }: { st: TrimmerSubtotal; columns: readonly ReportColumnKey[] }) {
  const has = (c: ReportColumnKey) => columns.includes(c)
  return (
    <li data-subtotal="" className="space-y-2 rounded-lg border-2 border-foreground/20 bg-muted/70 p-3">
      <p className="text-sm font-semibold">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subtotal</span>{' '}
        {st.trimmerName} &middot; {st.hangers} {st.hangers === 1 ? 'hanger' : 'hangers'}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {has('issued') && (
          <div>
            <dt className="text-xs text-muted-foreground">Issued</dt>
            <dd className="font-semibold">{gramsText(st.issuedG)}</dd>
          </div>
        )}
        {has('flower') && (
          <div>
            <dt className="text-xs text-muted-foreground">Flower</dt>
            <dd>
              <Mass g={st.flowerG} stacked />
            </dd>
          </div>
        )}
        {has('variance') && (
          <div>
            <dt className="text-xs text-muted-foreground">Variance</dt>
            <dd className="font-semibold">{signedGramsText(shownVariance(st.varianceG))}</dd>
          </div>
        )}
        {has('pay') && (
          <div>
            <dt className="text-xs text-muted-foreground">Pay</dt>
            <dd className="font-semibold">{moneyText(st.payAmount)}</dd>
          </div>
        )}
      </dl>
    </li>
  )
}

function EpisodeCard({ e, columns, showDates }: { e: TrimDayEpisode; columns: readonly ReportColumnKey[]; showDates: boolean }) {
  const has = (c: ReportColumnKey) => columns.includes(c)
  const identity = [
    has('batch') && (
      <span key="batch">
        <span className="font-medium">{e.batchName ?? DASH}</span>
        {e.strainName && <span className="text-muted-foreground"> · {e.strainName}</span>}
      </span>
    ),
    has('trimmer') && (
      <span key="trimmer" className="text-muted-foreground">
        {e.trimmerName}
      </span>
    ),
  ].filter(Boolean)
  return (
    <li className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <HangerLink code={e.hangerCode} />
          <Tags e={e} />
        </div>
        {has('status') && <StatusPill status={e.varianceStatus} />}
      </div>
      {identity.length > 0 && (
        <p className="text-sm">
          {identity.map((node, i) => (
            <span key={i}>
              {i > 0 && <span className="text-muted-foreground"> · </span>}
              {node}
            </span>
          ))}
        </p>
      )}
      {has('outIn') && (
        <p className="text-sm text-muted-foreground">
          {outIn(e, showDates)} ({hoursText(e.turnaroundHours)})
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {has('issued') && (
          <div>
            <dt className="text-xs text-muted-foreground">Issued</dt>
            <dd className="font-semibold">{gramsText(e.issuedG)}</dd>
          </div>
        )}
        {has('flower') && (
          <div>
            <dt className="text-xs text-muted-foreground">Flower</dt>
            <dd>
              <Mass g={e.flowerG} stacked />
            </dd>
          </div>
        )}
        {has('trim') && (
          <div>
            <dt className="text-xs text-muted-foreground">Trim</dt>
            <dd className="font-semibold">{gramsText(e.trimG)}</dd>
          </div>
        )}
        {has('stems') && (
          <div>
            <dt className="text-xs text-muted-foreground">Stems</dt>
            <dd className="font-semibold">{gramsText(e.stemsG)}</dd>
          </div>
        )}
        {has('variance') && (
          <div>
            <dt className="text-xs text-muted-foreground">Variance</dt>
            <dd>
              <VarianceText g={e.varianceG} pct={e.variancePct} />
            </dd>
          </div>
        )}
        {has('pay') && (
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
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────

export interface ReportDetailProps {
  episodes: readonly TrimDayEpisode[]
  /** Viewer may see dollars. False removes the Pay column from the table and from the column selector. */
  showMoney: boolean
  showDates: boolean
  sort: SortState
  onSortChange: (next: SortState) => void
  /** Changes whenever the filters do; a "show more" expansion starts over then. */
  resetKey: string
  /** Column choice. Defaults to the persisted per-device choice; injectable for tests. */
  columnState?: { hidden: readonly ReportColumnKey[]; toggle: (key: ReportColumnKey) => void; reset: () => void }
}

export function ReportDetail(props: ReportDetailProps) {
  const stored = useReportColumns()
  const { hidden, toggle, reset } = props.columnState ?? stored
  return <ReportDetailView {...props} hidden={hidden} onToggle={toggle} onReset={reset} />
}

export function ReportDetailView({
  episodes,
  showMoney,
  showDates,
  sort,
  onSortChange,
  resetKey,
  hidden,
  onToggle,
  onReset,
}: ReportDetailProps & { hidden: readonly ReportColumnKey[]; onToggle: (key: ReportColumnKey) => void; onReset: () => void }) {
  const columns = useMemo(() => resolveVisibleColumns(hidden, showMoney), [hidden, showMoney])
  const sorted = useMemo(() => sortEpisodes(episodes, sort), [episodes, sort])
  const withSubtotals = showsSubtotals(sort)
  // Built over every episode, then sliced for rendering: a subtotal always covers its whole block.
  const items = useMemo(() => buildDisplayItems(sorted, withSubtotals), [sorted, withSubtotals])

  const [expansion, setExpansion] = useState<{ key: string; max: number }>({ key: resetKey, max: RENDER_STEP })
  const max = expansion.key === resetKey ? expansion.max : RENDER_STEP
  const shown = useMemo(() => limitDisplayItems(items, max), [items, max])
  const total = episodes.length
  const moreToShow = shown.shownEpisodes < total
  const showMore = (all: boolean) => setExpansion({ key: resetKey, max: all ? total : max + RENDER_STEP })

  const sortable = selectableColumns(showMoney)
  const renderMobile = (item: DisplayItem) =>
    item.kind === 'subtotal' ? (
      <SubtotalCard key={`s-${item.subtotal.trimmerId}`} st={item.subtotal} columns={columns} />
    ) : (
      <EpisodeCard key={item.episode.checkoutId} e={item.episode} columns={columns} showDates={showDates} />
    )

  return (
    <section aria-label="Hangers" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Hanger detail <span className="text-base font-normal text-muted-foreground">({total})</span>
        </h2>
        <ColumnsMenu hidden={hidden} showMoney={showMoney} onToggle={onToggle} onReset={onReset} />
      </div>

      {/* Phones and tablets have no header row to click, so sorting is a control of its own. */}
      <div className="flex items-center gap-2 lg:hidden">
        <Select value={sort.key} onValueChange={(v) => onSortChange({ key: v as SortKey, dir: 'asc' })}>
          <SelectTrigger aria-label="Sort by" className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortable.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                Sort: {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={sort.dir === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'}
          onClick={() => onSortChange({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
        >
          {sort.dir === 'asc' ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </Button>
      </div>

      {/* Wide screens */}
      <div className="hidden rounded-lg border bg-card lg:block">
        {/* px-3 (not the default px-4) so the default nine columns fit a 1280px screen with the sidebar open. */}
        <Table className="[&_td]:px-3 [&_th]:px-3">
          <TableHeader>
            <TableRow>
              {columns.map((key) => {
                const def = columnDef(key)
                const active = sort.key === key
                return (
                  <TableHead
                    key={key}
                    className={def.numeric ? 'text-right' : undefined}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      className={cn('flex items-center font-medium hover:text-foreground', def.numeric && 'ml-auto')}
                      onClick={() => onSortChange(nextSort(sort, key))}
                    >
                      {def.label}
                      <SortIcon active={active} dir={sort.dir} />
                    </button>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.items.map((item) =>
              item.kind === 'subtotal' ? (
                <SubtotalRow
                  key={`s-${item.subtotal.trimmerId}`}
                  st={item.subtotal}
                  columns={columns}
                />
              ) : (
                <TableRow key={item.episode.checkoutId}>
                  {columns.map((col) => (
                    <EpisodeCells key={col} e={item.episode} col={col} showDates={showDates} />
                  ))}
                </TableRow>
              )
            )}
          </TableBody>
        </Table>
      </div>

      <ul className="space-y-3 lg:hidden">{shown.items.map(renderMobile)}</ul>

      {moreToShow && (
        <div className="flex flex-wrap items-center justify-center gap-2 py-1">
          <p className="w-full text-center text-sm text-muted-foreground">
            Showing {shown.shownEpisodes} of {total} hangers. Totals{withSubtotals ? ' and subtotals' : ''} cover all {total}.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => showMore(false)}>
            Show {RENDER_STEP} more
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => showMore(true)}>
            Show all {total}
          </Button>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Variance is shown the way the station shows it: negative means weight is missing; sorting by it puts the largest
        gap first, loss or gain. Times are Central. Tap a hanger for its full history.
      </p>
    </section>
  )
}
