'use client'

import { Fragment, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { BatchLoadEpisode, BatchLoadRow, BatchLoadsReport, BatchTrimmerRollup } from '@/actions/trim-reports'
import type { HangerLoadStatus } from '@/types/harvest-trim'
import {
  LOAD_STATUS_META,
  LOAD_STATUS_ORDER,
  VARIANCE_LABEL,
  VARIANCE_TONE,
  agoText,
  moneyText,
  pctText,
  plantsText,
  signedGramsText,
  whenText,
} from './format'
import { Mass } from './mass'

interface BatchLoadsSectionProps {
  report: BatchLoadsReport
  /** Dollars and rates. The caller passes `report.moneyVisible && canSeeTrimPay`; both must hold. */
  showMoney: boolean
  onOpenHanger: (code: string) => void
}

const DASH = '—'

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold">{children}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function StatusPill({ status }: { status: HangerLoadStatus }) {
  return (
    <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', LOAD_STATUS_META[status].pill)}>
      {LOAD_STATUS_META[status].label}
    </span>
  )
}

function returnLabel(ep: BatchLoadEpisode): string {
  if (ep.status === 'out') return `Out since ${whenText(ep.checkedOutAt)} (${agoText(ep.checkedOutAt)})`
  if (ep.status === 'released') return 'Released, not trimmed'
  return ep.returnKind === 'unfinished' ? 'Unfinished' : 'Finished'
}

/**
 * Variance as the rest of the module shows it: a loss is negative ("-419 g"). The database stores
 * issued minus accounted-for, so a loss is positive there and is flipped here.
 */
function VarianceCell({ ep }: { ep: BatchLoadEpisode }) {
  if (ep.status !== 'returned' || ep.varianceG === null) return <span className="text-muted-foreground">{DASH}</span>
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="font-semibold">
        {signedGramsText(-ep.varianceG)} ({pctText(ep.variancePct === null ? null : -ep.variancePct, 1, true)})
      </span>
      {ep.varianceStatus && (
        <span className={cn('rounded-full border px-2 py-0.5 text-xs font-semibold', VARIANCE_TONE[ep.varianceStatus])}>
          {VARIANCE_LABEL[ep.varianceStatus]}
        </span>
      )}
    </span>
  )
}

function bucket(ep: BatchLoadEpisode, g: number | null) {
  return ep.status === 'returned' ? <Mass g={g} stacked /> : <span className="text-muted-foreground">{DASH}</span>
}

function FlowerShare({ t }: { t: BatchTrimmerRollup }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="font-semibold">{pctText(t.flowerSharePct, 1)}</span>
      {t.flowerShareDeltaPts !== null && (
        <span className="text-xs text-muted-foreground">
          {t.flowerShareDeltaPts > 0 ? '+' : ''}
          {t.flowerShareDeltaPts.toFixed(1)} pts from the batch
        </span>
      )}
      {t.isFlowerShareOutlier && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3" />
          Outlier
        </span>
      )}
    </span>
  )
}

function ratesText(t: BatchTrimmerRollup): string {
  if (!t.ratesPerLb || t.ratesPerLb.length === 0) return DASH
  return t.ratesPerLb.map((r) => `${moneyText(r)}/lb`).join(', ')
}

function FlaggedPill({ t, showMoney }: { t: BatchTrimmerRollup; showMoney: boolean }) {
  if (t.pendingFlaggedEpisodes === 0) return null
  return (
    <span className="inline-block rounded-full border border-red-500/50 bg-red-500/15 px-2.5 py-0.5 text-xs font-semibold text-red-700 dark:text-red-300">
      {t.pendingFlaggedEpisodes} flagged{showMoney ? ', no pay yet' : ', unresolved'}
    </span>
  )
}

/**
 * The batch's real table: totals, a per-trimmer rollup, and every hanger with its custody episodes.
 * This is the one table-shaped screen in the module, so below `lg` each trimmer and each hanger is a
 * card carrying the same figures. Nothing is hidden at a narrow width.
 */
export function BatchLoadsSection({ report, showMoney, onOpenHanger }: BatchLoadsSectionProps) {
  const [statusFilter, setStatusFilter] = useState<HangerLoadStatus | 'all'>('all')
  const { totals, trimmers } = report

  const counts = useMemo(() => {
    const c: Partial<Record<HangerLoadStatus, number>> = {}
    for (const l of report.loads) c[l.status] = (c[l.status] ?? 0) + 1
    return c
  }, [report.loads])

  const shown = useMemo(
    () => report.loads.filter((l) => statusFilter === 'all' || l.status === statusFilter),
    [report.loads, statusFilter]
  )

  const pendingFlagged = trimmers.reduce((sum, t) => sum + t.pendingFlaggedEpisodes, 0)
  const flaggedTrimmers = trimmers.filter((t) => t.pendingFlaggedEpisodes > 0)

  return (
    <div className="space-y-6">
      {/* Batch totals */}
      <section aria-label="Weights and returns" className="space-y-3">
        <h2 className="text-lg font-semibold">Weights and returns</h2>
        {pendingFlagged > 0 && (
          <div role="alert" className="flex items-start gap-3 rounded-lg border-2 border-red-500/60 bg-red-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <p className="text-sm font-medium">
              {pendingFlagged} flagged {pendingFlagged === 1 ? 'return is' : 'returns are'} still unresolved
              {flaggedTrimmers.length > 0 && <> ({flaggedTrimmers.map((t) => t.trimmerName).join(', ')})</>}.
              {showMoney ? (
                <> Nothing is owed on {pendingFlagged === 1 ? 'it' : 'them'} until {pendingFlagged === 1 ? 'it is' : 'they are'} decided, so the amount below is not final.</>
              ) : (
                <> Their weights are in the totals below, but they are not final until decided.</>
              )}
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Hangers" sub={totals.openLoads > 0 ? `${totals.openLoads} still open` : 'all finished'}>
            {totals.loads}
          </Stat>
          <Stat label="Plants">{totals.plants}</Stat>
          <Stat label="Wet">
            <Mass g={totals.wetG} stacked />
          </Stat>
          <Stat label="Dry">
            <Mass g={totals.dryG} stacked />
          </Stat>
          <Stat label="Left on hangers">
            <Mass g={totals.remainingG} stacked />
          </Stat>
          <Stat label="Returns" sub="trimmer returns">
            {totals.episodes}
          </Stat>
          <Stat label="Flower">
            <Mass g={totals.flowerG} stacked />
          </Stat>
          <Stat label="Flower share" sub="of everything returned">
            {pctText(totals.flowerSharePct, 1)}
          </Stat>
          <Stat label="Trim">
            <Mass g={totals.trimG} stacked />
          </Stat>
          <Stat label="Stems">
            <Mass g={totals.stemsG} stacked />
          </Stat>
          {showMoney && (
            <Stat label="Owed" sub={pendingFlagged > 0 ? 'excludes flagged returns' : 'pay lines so far'}>
              {moneyText(totals.amountOwed)}
            </Stat>
          )}
        </div>
        {totals.voidLoads > 0 && (
          <p className="text-sm text-muted-foreground">
            {totals.voidLoads} void {totals.voidLoads === 1 ? 'hanger is' : 'hangers are'} listed below and left out of
            every total.
          </p>
        )}
      </section>

      {/* Per trimmer */}
      <section aria-label="Per trimmer" className="space-y-3">
        <h2 className="text-lg font-semibold">
          By trimmer <span className="text-base font-normal text-muted-foreground">({trimmers.length})</span>
        </h2>
        {trimmers.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-center text-muted-foreground">
            No trimmer has returned a hanger from this batch yet.
          </p>
        ) : (
          <>
            {/* Wide screens */}
            <div className="hidden rounded-lg border bg-card lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trimmer</TableHead>
                    <TableHead className="text-right">Returns</TableHead>
                    <TableHead className="text-right">Hangers</TableHead>
                    <TableHead>Flower</TableHead>
                    {showMoney && <TableHead>Rate</TableHead>}
                    {showMoney && <TableHead className="text-right">Owed</TableHead>}
                    <TableHead>Flower share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trimmers.map((t) => (
                    <TableRow key={t.trimmerId} className={cn(t.isFlowerShareOutlier && 'bg-amber-500/5')}>
                      <TableCell className="align-top">
                        <p className="text-base font-semibold">{t.trimmerName}</p>
                        <FlaggedPill t={t} showMoney={showMoney} />
                      </TableCell>
                      <TableCell className="text-right align-top">{t.episodes}</TableCell>
                      <TableCell className="text-right align-top">{t.hangers}</TableCell>
                      <TableCell className="align-top">
                        <Mass g={t.flowerG} stacked />
                      </TableCell>
                      {showMoney && <TableCell className="align-top">{ratesText(t)}</TableCell>}
                      {showMoney && (
                        <TableCell className="text-right align-top font-semibold">{moneyText(t.amountOwed)}</TableCell>
                      )}
                      <TableCell className="align-top">
                        <FlowerShare t={t} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Phones and tablets */}
            <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
              {trimmers.map((t) => (
                <li
                  key={t.trimmerId}
                  className={cn(
                    'space-y-2 rounded-lg border p-3',
                    t.isFlowerShareOutlier ? 'border-amber-500/60 bg-amber-500/5' : 'bg-card'
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-lg font-semibold">{t.trimmerName}</p>
                    <FlaggedPill t={t} showMoney={showMoney} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Returns / hangers</dt>
                      <dd className="font-semibold">
                        {t.episodes} / {t.hangers}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Flower</dt>
                      <dd>
                        <Mass g={t.flowerG} stacked />
                      </dd>
                    </div>
                    {showMoney && (
                      <>
                        <div>
                          <dt className="text-xs text-muted-foreground">Rate</dt>
                          <dd className="font-semibold">{ratesText(t)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Owed</dt>
                          <dd className="font-semibold">{moneyText(t.amountOwed)}</dd>
                        </div>
                      </>
                    )}
                    <div className="col-span-2">
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
                ? `Flower share is measured against the batch median of ${pctText(report.baselineFlowerSharePct, 1)}. An outlier is well away from it and worth a look: moving material from the trim bin to the flower bin raises pay and cannot trip a weight flag.`
                : 'Not enough has been returned yet to set a batch median, so no one is marked as an outlier.'}
            </p>
          </>
        )}
      </section>

      {/* Per hanger */}
      <section aria-label="Hangers" className="space-y-3">
        <h2 className="text-lg font-semibold">
          Hangers <span className="text-base font-normal text-muted-foreground">({report.loads.length})</span>
        </h2>
        {report.loads.length === 0 ? (
          <p className="rounded-lg border bg-card p-4 text-center text-muted-foreground">
            No hangers have been weighed into this batch yet.
          </p>
        ) : (
          <>
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Filter by status">
              <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
                All {report.loads.length}
              </FilterChip>
              {LOAD_STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
                <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                  {LOAD_STATUS_META[s].label.split(',')[0]} {counts[s]}
                </FilterChip>
              ))}
            </div>

            {/* Wide screens */}
            <div className="hidden rounded-lg border bg-card lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hanger</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Plants</TableHead>
                    <TableHead>Wet</TableHead>
                    <TableHead>Dry</TableHead>
                    <TableHead>Left on hanger</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((l) => (
                    <Fragment key={l.loadId}>
                      <TableRow className={cn(l.status === 'void' && 'bg-muted/40 text-muted-foreground')}>
                        <TableCell className="align-top">
                          <HangerButton code={l.hangerCode} onOpen={onOpenHanger} />
                        </TableCell>
                        <TableCell className="align-top">
                          <StatusPill status={l.status} />
                          {l.status === 'void' && (
                            <p className="mt-1 text-xs">Left out of every total</p>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">{l.plantCount ?? DASH}</TableCell>
                        <TableCell className="align-top">
                          <Mass g={l.wetG} stacked />
                        </TableCell>
                        <TableCell className="align-top">
                          <Mass g={l.dryG} stacked />
                        </TableCell>
                        <TableCell className="align-top">
                          {l.status === 'partial' || (l.remainingG ?? 0) > 0 ? (
                            <span className="inline-flex flex-col">
                              <Mass g={l.remainingG} stacked />
                              {l.remainingPlantCount !== null && (
                                <span className="text-xs text-muted-foreground">{plantsText(l.remainingPlantCount)}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{DASH}</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {l.episodes.length > 0 && (
                        <TableRow className={cn('hover:bg-transparent', l.status === 'void' && 'bg-muted/40')}>
                          <TableCell colSpan={6} className="pb-4 pt-0">
                            <EpisodeTable episodes={l.episodes} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Phones and tablets */}
            <ul className="space-y-3 lg:hidden">
              {shown.map((l) => (
                <LoadCard key={l.loadId} load={l} onOpenHanger={onOpenHanger} />
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Variance is shown the way the station shows it: negative means weight is missing. Tap a tag for its full
              history.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-12 shrink-0 rounded-lg border-2 px-4 text-sm font-semibold',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
      )}
    >
      {children}
    </button>
  )
}

function HangerButton({ code, onOpen }: { code: string; onOpen: (code: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(code)}
      className="flex min-h-12 items-center rounded-md px-1 text-left font-mono text-base font-bold underline-offset-4 hover:underline"
    >
      {code}
    </button>
  )
}

/** The custody episodes of one hanger, as a compact table (wide screens). */
function EpisodeTable({ episodes }: { episodes: BatchLoadEpisode[] }) {
  return (
    <div className="rounded-md border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            <TableHead>Trimmer</TableHead>
            <TableHead>Return</TableHead>
            <TableHead>Flower</TableHead>
            <TableHead>Trim</TableHead>
            <TableHead>Stems</TableHead>
            <TableHead>Variance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {episodes.map((ep) => (
            <TableRow key={ep.id}>
              <TableCell className="align-top font-semibold">{ep.seq}</TableCell>
              <TableCell className="align-top">{ep.trimmerName}</TableCell>
              <TableCell className="align-top">{returnLabel(ep)}</TableCell>
              <TableCell className="align-top">{bucket(ep, ep.flowerG)}</TableCell>
              <TableCell className="align-top">{bucket(ep, ep.trimG)}</TableCell>
              <TableCell className="align-top">{bucket(ep, ep.stemsG)}</TableCell>
              <TableCell className="align-top">
                <VarianceCell ep={ep} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** One hanger as a card (phones and tablets): the same figures as the table row, nothing dropped. */
function LoadCard({ load: l, onOpenHanger }: { load: BatchLoadRow; onOpenHanger: (code: string) => void }) {
  const isVoid = l.status === 'void'
  return (
    <li className={cn('space-y-3 rounded-lg border p-3', isVoid ? 'border-dashed bg-muted/40' : 'bg-card')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <HangerButton code={l.hangerCode} onOpen={onOpenHanger} />
        <StatusPill status={l.status} />
      </div>
      {isVoid && <p className="text-sm text-muted-foreground">Void: left out of every total and every yield figure.</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Plants</dt>
          <dd className="font-semibold">{l.plantCount ?? DASH}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Wet</dt>
          <dd>
            <Mass g={l.wetG} stacked />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Dry</dt>
          <dd>
            <Mass g={l.dryG} stacked />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Left on hanger</dt>
          <dd>
            {l.status === 'partial' || (l.remainingG ?? 0) > 0 ? (
              <>
                <Mass g={l.remainingG} stacked />
                {l.remainingPlantCount !== null && (
                  <span className="block text-xs text-muted-foreground">{plantsText(l.remainingPlantCount)}</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{DASH}</span>
            )}
          </dd>
        </div>
      </dl>

      {l.episodes.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {l.episodes.length} {l.episodes.length === 1 ? 'trimmer episode' : 'trimmer episodes'}
          </p>
          {l.episodes.map((ep) => (
            <div key={ep.id} className="space-y-2 rounded-md border bg-background p-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  #{ep.seq} {ep.trimmerName}
                </p>
                <span className="text-xs text-muted-foreground">{returnLabel(ep)}</span>
              </div>
              {ep.status === 'returned' && (
                <dl className="grid grid-cols-3 gap-x-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Flower</dt>
                    <dd>
                      <Mass g={ep.flowerG} stacked />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Trim</dt>
                    <dd>
                      <Mass g={ep.trimG} stacked />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Stems</dt>
                    <dd>
                      <Mass g={ep.stemsG} stacked />
                    </dd>
                  </div>
                </dl>
              )}
              <VarianceCell ep={ep} />
            </div>
          ))}
        </div>
      )}
    </li>
  )
}
