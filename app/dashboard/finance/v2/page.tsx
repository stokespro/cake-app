'use client'

/**
 * Cash Board (v2) — Phase 0a.
 *
 * READ ONLY. This screen writes nothing — no server actions that mutate,
 * no mutations triggered from here. Pay / Hold are rendered but permanently
 * `disabled`, with a tooltip explaining why, so there is no click handler
 * to ever accidentally wire to something real. Real payment actions land in
 * Phase 1.
 *
 * Data comes from a single call to getCashBoard() (see ./_actions/board),
 * against the CashBoardData contract in ./types.ts. This file renders that
 * contract — it does not reshape or recompute the numbers it's given
 * (every figure here is already computed server-side); the only client-side
 * work is sorting for display (biggest dollars first) and capping long
 * lists, both of which are presentation concerns.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorState } from '@/components/ui/error-state'
import {
  AlertTriangle,
  ArrowDownCircle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Minus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getCashBoard } from './_actions/board'
import type {
  AgingBucket,
  AvailabilityTier,
  BillTriage,
  CashBoardData,
  Confidence,
  DecisionBill,
  DecisionGroup,
  ExceptionGroup,
  ExceptionItem,
  ExceptionKind,
  InflowForecast,
  Lever,
  MoneyInLine,
  ReceivableItem,
  Verdict,
} from './types'

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

// Full precision — used for every figure the reader might act on (Safe to
// Pay, individual bills, individual receivables). Matches the formatter
// used on the existing Finance Overview page for consistency.
function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

// Whole-dollar — used only for compact summary tiles (aging buckets, the
// inflow forecast trio) where three tiles have to fit a 390px-wide row and
// cents would just be noise. Every other number on this screen is exact.
function formatMoneyRounded(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
}

function formatDateShort(d: string): string {
  return format(parseISO(d), 'MMM d')
}

// Weekday-qualified — reserved for the one or two bills the reader is being
// asked to act on right now (the bill that doesn't fit, the bill a lever
// defers). Everywhere else uses formatDateShort(); this is intentionally
// louder, matching how "the one thing that matters" was dated in the
// previous hero.
function formatDateWeekday(d: string): string {
  return format(parseISO(d), 'EEE, MMM d')
}

// -----------------------------------------------------------------------
// Inert Pay / Hold — rendered everywhere a real action will eventually go,
// permanently disabled so there is no click handler to ever misfire, with
// a tooltip explaining why. The wrapping <span> (not the button) is the
// tooltip trigger because a disabled button doesn't receive pointer/focus
// events to open it.
// -----------------------------------------------------------------------

function InertPayHoldActions() {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>
            <Button size="sm" variant="outline" disabled className="h-7 px-2.5 text-xs">
              Hold
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Coming in Phase 1</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>
            <Button size="sm" disabled className="h-7 px-2.5 text-xs">
              Pay
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Coming in Phase 1</TooltipContent>
      </Tooltip>
    </div>
  )
}

// -----------------------------------------------------------------------
// Hero config — tiers, confidence, and verdict. One place each so the
// toggle, the ledger filter, and the headline color can never drift out
// of sync with each other.
// -----------------------------------------------------------------------

const TIER_ORDER: AvailabilityTier[] = ['conservative', 'likely', 'optimistic']

const TIER_LABEL: Record<AvailabilityTier, string> = {
  conservative: 'Conservative',
  likely: 'Likely',
  optimistic: 'Optimistic',
}

// One short line each — shown under the toggle so a tier is never a guess.
const TIER_DESCRIPTION: Record<AvailabilityTier, string> = {
  conservative: 'Cash only.',
  likely: 'Cash + confirmed deliveries + terms due this week.',
  optimistic: '+ overdue receivables and unconfirmed orders.',
}

// Deliberately grayscale — a fade in the same muted color rather than a
// second color-coded system competing with the verdict for attention.
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  certain: 'Certain',
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

const CONFIDENCE_DOT_CLASS: Record<Confidence, string> = {
  certain: 'bg-foreground/70',
  high: 'bg-foreground/50',
  medium: 'bg-foreground/30',
  low: 'bg-foreground/15',
}

const VERDICT_CONFIG: Record<Verdict, { textClass: string; borderClass: string; Icon: LucideIcon }> = {
  short: {
    textClass: 'text-red-600 dark:text-red-500',
    borderClass: 'border-l-red-600',
    Icon: TrendingDown,
  },
  break_even: {
    textClass: 'text-amber-600 dark:text-amber-500',
    borderClass: 'border-l-amber-500',
    Icon: Minus,
  },
  surplus: {
    textClass: 'text-green-700 dark:text-green-500',
    borderClass: 'border-l-green-600',
    Icon: TrendingUp,
  },
}

// The only place "short"/"surplus" get a dollar amount attached — break-even
// stays a bare word since the number behind it is ~$0 and printing it would
// just be noise next to the two operands in the line below.
function verdictHeadline(verdict: Verdict, net: number): string {
  if (verdict === 'short') return `SHORT ${formatMoney(Math.abs(net))}`
  if (verdict === 'surplus') return `SURPLUS ${formatMoney(net)}`
  return 'BREAK EVEN'
}

// -----------------------------------------------------------------------
// Hero — his four questions, in order: what I owe + what I have (the
// ledger), am I short/even/surplus (the verdict), which bills get paid
// (triage), and how to close the gap (levers). Nothing here is computed
// client-side beyond filtering moneyIn lines to the selected tier and
// picking which of the three already-computed tier totals to show —
// availableByTier/netByTier/verdictByTier come straight from the server.
// -----------------------------------------------------------------------

function Hero({ data }: { data: CashBoardData }) {
  const { ledger } = data
  const [tier, setTier] = useState<AvailabilityTier>(ledger.defaultTier)
  // Triage and levers are computed per tier, so flipping the toggle moves the
  // bill-by-bill answer too — today 22 / 28 / 29 bills fit at conservative /
  // likely / optimistic. A static triage under a moving verdict would make the
  // screen contradict itself.
  const triage = data.triage[tier]
  const levers = data.levers[tier]

  const verdict = ledger.verdictByTier[tier]
  const net = ledger.netByTier[tier]
  const available = ledger.availableByTier[tier]
  const verdictCfg = VERDICT_CONFIG[verdict]
  const VerdictIcon = verdictCfg.Icon
  const tierRank = TIER_ORDER.indexOf(tier)
  const visibleMoneyIn = ledger.moneyIn.filter((line) => TIER_ORDER.indexOf(line.tier) <= tierRank)

  return (
    <Card className={`overflow-hidden border-l-4 ${verdictCfg.borderClass}`}>
      <CardContent className="space-y-4 p-4 sm:space-y-5 sm:p-6">
        {/* Tier toggle + data provenance */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Tabs value={tier} onValueChange={(v) => setTier(v as AvailabilityTier)}>
              <TabsList className="h-8 p-0.5">
                {TIER_ORDER.map((t) => (
                  <TabsTrigger key={t} value={t} className="px-2.5 py-1 text-xs">
                    {TIER_LABEL[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="mt-1.5 text-xs text-muted-foreground">{TIER_DESCRIPTION[tier]}</p>
          </div>
          {data.cashSource === 'manual' && (
            <span className="text-xs text-muted-foreground">Manual cash entry</span>
          )}
        </div>

        {/* 3. The verdict — the largest thing in the hero */}
        <div>
          <div
            className={`flex items-center gap-2 text-4xl font-extrabold leading-none tabular-nums sm:text-5xl ${verdictCfg.textClass}`}
          >
            <VerdictIcon className="h-8 w-8 shrink-0 sm:h-9 sm:w-9" aria-hidden="true" />
            <span>{verdictHeadline(verdict, net)}</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {formatMoney(available)} available − {formatMoney(ledger.billsDueTotal)} owed this week.
          </p>
        </div>

        <Separator />

        {/* 1 + 2. What I owe, and what I have */}
        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            The week · {formatDateShort(ledger.windowStart)} – {formatDateShort(ledger.windowEnd)}
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Money in
              </div>
              <div className="mt-2 space-y-2.5">
                {visibleMoneyIn.map((line) => (
                  <MoneyInLineRow key={line.key} line={line} />
                ))}
              </div>
              <div className="mt-2.5 flex items-baseline justify-between border-t pt-2">
                <span className="text-xs font-semibold uppercase tracking-wide">Available</span>
                <span className="font-mono text-base font-bold tabular-nums">{formatMoney(available)}</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Money out
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-3">
                <span className="text-sm">
                  {ledger.billsDueCount} bill{ledger.billsDueCount !== 1 ? 's' : ''} due
                </span>
                <span className="shrink-0 font-mono text-sm font-medium tabular-nums">
                  {formatMoney(ledger.billsDueTotal)}
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline justify-between border-t pt-2">
                <span className="text-xs font-semibold uppercase tracking-wide">Owed</span>
                <span className="font-mono text-base font-bold tabular-nums">
                  {formatMoney(ledger.billsDueTotal)}
                </span>
              </div>
            </div>
          </div>

          {/* Days of cash — demoted from headline to a small context line;
              it assumes a smooth burn, which his rarely is. */}
          <p className="mt-3 text-xs text-muted-foreground">
            {data.daysOfCashLeft === null
              ? 'Not burning cash right now — trailing 30-day outflow is at or below zero.'
              : `Cash on hand alone, no incoming money, would last ${data.daysOfCashLeft.toFixed(1)} days at the trailing burn rate (${formatMoney(data.avgDailyOutflow)}/day).`}
          </p>
        </div>

        <Separator />

        {/* 4a. Which bills get paid */}
        <TriageSection triage={triage} />

        {/* 4b. How to close the gap — empty (and hidden) unless short */}
        {levers.length > 0 && (
          <>
            <Separator />
            <LeversSection levers={levers} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function MoneyInLineRow({ line }: { line: MoneyInLine }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${CONFIDENCE_DOT_CLASS[line.confidence]}`}
                aria-label={CONFIDENCE_LABEL[line.confidence]}
              />
            </TooltipTrigger>
            <TooltipContent side="top">{CONFIDENCE_LABEL[line.confidence]}</TooltipContent>
          </Tooltip>
          <span className="truncate text-sm">{line.label}</span>
        </div>
        {line.note && <p className="mt-0.5 pl-3 text-xs text-muted-foreground">{line.note}</p>}
      </div>
      <span className="shrink-0 font-mono text-sm font-medium tabular-nums">{formatMoney(line.amount)}</span>
    </div>
  )
}

function TriageSection({ triage }: { triage: BillTriage }) {
  const [showCovered, setShowCovered] = useState(false)
  const totalBills = triage.covered.length + triage.notCovered.length

  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Which bills get paid
      </div>
      <p className="text-sm">
        <span className="font-semibold">
          You can cover {triage.covered.length} of {totalBills} bill{totalBills !== 1 ? 's' : ''}.
        </span>{' '}
        Paying them costs {formatMoney(triage.coveredTotal)} and leaves {formatMoney(triage.leftover)}.
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Oldest bills first, at the {TIER_LABEL[triage.tier].toLowerCase()} estimate (
        {formatMoney(triage.available)} available).
      </p>

      {triage.covered.length > 0 && (
        <Collapsible open={showCovered} onOpenChange={setShowCovered} className="mt-2.5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={showCovered}
            >
              {showCovered ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {showCovered ? 'Hide' : 'Show'} the {triage.covered.length} covered bill
              {triage.covered.length !== 1 ? 's' : ''}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 divide-y rounded-md border">
              {triage.covered.map((bill) => (
                <TriageBillRow key={bill.id} bill={bill} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {triage.notCovered.length === 0 ? (
        <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-400">
          Every bill due this week fits. Nothing left uncovered.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Doesn&apos;t fit
          </div>
          {triage.notCovered.map((bill, i) => (
            <NotCoveredBillRow
              key={bill.id}
              bill={bill}
              shortfall={i === 0 ? triage.shortfallOnNext : null}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TriageBillRow({ bill }: { bill: DecisionBill }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{bill.name}</span>
            {bill.isPastDue && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                Past due
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {bill.vendorName && <span>{bill.vendorName} · </span>}
            Due {formatDateShort(bill.dueDate)}
          </div>
        </div>
        <div className="shrink-0 font-mono text-sm font-medium">{formatMoney(bill.remaining)}</div>
      </div>
      <div className="mt-2 flex justify-end">
        <InertPayHoldActions />
      </div>
    </div>
  )
}

function NotCoveredBillRow({ bill, shortfall }: { bill: DecisionBill; shortfall: number | null }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2.5 dark:border-red-900 dark:bg-red-950/15">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{bill.name}</span>
            {bill.vendorName && (
              <span className="text-xs font-normal text-muted-foreground">— {bill.vendorName}</span>
            )}
            {bill.isPastDue && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                Past due
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Due {formatDateWeekday(bill.dueDate)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-bold text-red-700 dark:text-red-500">
            {formatMoney(bill.remaining)}
          </div>
          {shortfall !== null && (
            <div className="text-[11px] font-semibold text-red-600 dark:text-red-500">
              short {formatMoney(shortfall)}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <InertPayHoldActions />
      </div>
    </div>
  )
}

function LeversSection({ levers }: { levers: Lever[] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        How to close the gap
      </div>
      <div className="divide-y rounded-md border">
        {levers.map((lever) => (
          <LeverRow key={lever.key} lever={lever} />
        ))}
      </div>
    </div>
  )
}

function LeverRow({ lever }: { lever: Lever }) {
  return (
    <div
      className={`flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
        lever.closesGap ? 'bg-green-50/60 dark:bg-green-950/10' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{lever.label}</span>
          {lever.closesGap && (
            <Badge
              variant="outline"
              className="border-green-300 px-1.5 py-0 text-[10px] text-green-700 dark:border-green-800 dark:text-green-500"
            >
              Any one of these fixes it
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{lever.detail}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm font-semibold tabular-nums">+{formatMoney(lever.amount)}</div>
        <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
          → {formatMoney(lever.resultingNet)} net
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------
// Panel 2 — This Week's Decisions
// -----------------------------------------------------------------------

const DECISIONS_CAP = 25

function DecisionsPanel({ groups }: { groups: DecisionGroup[] }) {
  // Grouping is already a UI concern per the DecisionGroup contract — sorting
  // for display is too. Biggest dollars first, everywhere on this screen.
  const sorted = [...groups].sort((a, b) => b.total - a.total)
  const visible = sorted.slice(0, DECISIONS_CAP)
  const overflow = sorted.length - visible.length

  // The header total is summed from `groups` itself, not from the hero's
  // `committedThisWeek` (a strict rolling-7-day figure) — decisionGroups can
  // include bills further out than 7 days, so a 7-day total would silently
  // undercount what's actually listed below it. Same reasoning for the
  // "through <date>" copy: it's derived from the real furthest due date in
  // the data rather than a hardcoded day count, so it can't drift out of
  // sync with whatever window the data layer actually uses.
  const totalDue = groups.reduce((sum, g) => sum + g.total, 0)
  const furthestDueDate =
    groups.length > 0
      ? groups.reduce((max, g) => (g.earliestDueDate > max ? g.earliestDueDate : max), groups[0].earliestDueDate)
      : null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            This Week&apos;s Decisions
          </CardTitle>
          {groups.length > 0 && (
            <span className="font-mono text-sm font-semibold">{formatMoney(totalDue)} due</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {furthestDueDate
            ? `Upcoming bills through ${formatDateShort(furthestDueDate)}, ranked by amount.`
            : 'Upcoming bills, ranked by amount.'}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing on the horizon right now.
          </div>
        ) : (
          <div className="divide-y">
            {visible.map((group) => (
              <DecisionGroupRow key={group.key} group={group} />
            ))}
          </div>
        )}
        {overflow > 0 && (
          <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            Showing top {visible.length} of {sorted.length}, by amount.
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DecisionGroupRow({ group }: { group: DecisionGroup }) {
  const [open, setOpen] = useState(false)
  const displayLabel = group.isGroup ? `${group.billCount} × ${group.label}` : group.label

  return (
    <div>
      <div className="px-3 py-3 sm:px-4">
        <div className="flex items-start gap-2">
          {group.isGroup && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              aria-label={open ? 'Collapse bills' : 'Expand bills'}
            >
              {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{displayLabel}</span>
              {group.isPastDue && (
                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                  Past due
                </Badge>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {group.vendorName && <span>{group.vendorName} · </span>}
              Due {formatDateShort(group.earliestDueDate)}
            </div>
          </div>
          <div className="shrink-0 text-right font-mono text-sm font-semibold sm:text-base">
            {formatMoney(group.total)}
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <InertPayHoldActions />
        </div>
      </div>
      {group.isGroup && open && (
        <div className="divide-y border-t bg-muted/30">
          {group.bills.map((bill) => (
            <DecisionBillRow key={bill.id} bill={bill} />
          ))}
        </div>
      )}
    </div>
  )
}

function DecisionBillRow({ bill }: { bill: DecisionBill }) {
  const isPartial = bill.amountPaid > 0

  return (
    <div className="py-2.5 pl-8 pr-3 sm:pl-12 sm:pr-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{bill.name}</span>
            {bill.isPastDue && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                Past due
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {bill.vendorName && <span>{bill.vendorName} · </span>}
            Due {formatDateShort(bill.dueDate)}
            {isPartial && <span> · {formatMoney(bill.amountPaid)} paid</span>}
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-sm font-medium">
          {formatMoney(bill.remaining)}
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <InertPayHoldActions />
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------
// Panel 3 — Money Coming In
// -----------------------------------------------------------------------

const AGING_BUCKET_ORDER: AgingBucket[] = ['0-15', '16-30', '31+']
const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  '0-15': '0–15 days',
  '16-30': '16–30 days',
  '31+': '31+ days',
}
const RECEIVABLES_CAP = 10

function MoneyComingInPanel({
  receivables,
  inflowForecast,
}: {
  receivables: CashBoardData['receivables']
  inflowForecast: InflowForecast
}) {
  const orderedBuckets = AGING_BUCKET_ORDER.map((label) =>
    receivables.buckets.find((b) => b.label === label)
  ).filter((b): b is { label: AgingBucket; count: number; total: number } => b !== undefined)

  // Rank by dollars everywhere, same as the other panels.
  const sortedItems = [...receivables.items].sort((a, b) => b.amount - a.amount)
  const visibleItems = sortedItems.slice(0, RECEIVABLES_CAP)
  const overflow = sortedItems.length - visibleItems.length

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Money Coming In
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Aging buckets — 31+ is deliberately the loudest tile. */}
        <div>
          <div className="grid grid-cols-3 gap-2">
            {orderedBuckets.map((bucket) => (
              <AgingBucketTile key={bucket.label} bucket={bucket} loud={bucket.label === '31+'} />
            ))}
          </div>
          {receivables.notYetDue > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              + {formatMoneyRounded(receivables.notYetDue)} not yet due
            </p>
          )}
        </div>

        <Separator />

        {/* Inflow forecast — the conservative weekly number is the planning
            number and is visually loudest; median and pipeline are context
            only, and are labeled as such so the two are never confused. */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Weekly inflow forecast
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border-2 border-blue-300 bg-blue-50 px-3 py-2.5 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                Plan around this
              </div>
              <div className="font-mono text-xl font-bold">
                {formatMoneyRounded(inflowForecast.conservativeWeekly)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Conservative weekly (25th pct)
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Typical week
              </div>
              <div className="font-mono text-lg font-semibold text-muted-foreground">
                {formatMoneyRounded(inflowForecast.medianWeekly)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">Median · context only</div>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Pipeline now
              </div>
              <div className="font-mono text-lg font-semibold text-muted-foreground">
                {formatMoneyRounded(inflowForecast.pipelineNow)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Confirmed + packed + pending · context only
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Based on {inflowForecast.weeksSampled} week{inflowForecast.weeksSampled !== 1 ? 's' : ''} of
            delivered revenue.
          </p>
        </div>

        <Separator />

        {/* Item list */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Open receivables
          </div>
          {visibleItems.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No open receivables.</div>
          ) : (
            <div className="divide-y rounded-md border">
              {visibleItems.map((item) => (
                <ReceivableItemRow key={item.orderId} item={item} />
              ))}
            </div>
          )}
          {overflow > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing top {visibleItems.length} of {sortedItems.length}, by amount.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function AgingBucketTile({
  bucket,
  loud,
}: {
  bucket: { label: AgingBucket; count: number; total: number }
  loud?: boolean
}) {
  const toneClass = loud
    ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/25 dark:text-red-400'
    : bucket.label === '16-30'
      ? 'border-amber-200 bg-amber-50/70 text-amber-700 dark:border-amber-800 dark:bg-amber-950/15 dark:text-amber-500'
      : 'border-border bg-muted/30 text-foreground'

  return (
    <div className={`rounded-md border px-2.5 py-2.5 sm:px-3 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80 sm:text-[11px]">
        {AGING_BUCKET_LABEL[bucket.label]}
      </div>
      <div className={`font-mono font-bold ${loud ? 'text-lg sm:text-2xl' : 'text-base sm:text-lg'}`}>
        {formatMoneyRounded(bucket.total)}
      </div>
      <div className="text-[11px] opacity-70">
        {bucket.count} order{bucket.count !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

function ReceivableItemRow({ item }: { item: ReceivableItem }) {
  const isOverdue = item.daysOverdue > 0

  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{item.customerName ?? 'Unknown customer'}</div>
        <div className="truncate text-xs text-muted-foreground">
          Order {item.orderNumber}
          {item.deliveredAt && <span> · Delivered {formatDateShort(item.deliveredAt)}</span>}
        </div>
        <div className={`mt-0.5 text-xs ${isOverdue ? 'font-medium text-red-600 dark:text-red-500' : 'text-muted-foreground'}`}>
          {isOverdue
            ? `${item.daysOverdue} day${item.daysOverdue !== 1 ? 's' : ''} overdue`
            : item.expectedDate
              ? `Expected ${formatDateShort(item.expectedDate)}`
              : 'Not yet due'}
        </div>
      </div>
      <div className="shrink-0 font-mono text-sm font-semibold">{formatMoney(item.amount)}</div>
    </div>
  )
}

// -----------------------------------------------------------------------
// Panel 4 — Exceptions ("Things that don't add up")
// -----------------------------------------------------------------------

const EXCEPTION_META: Record<
  ExceptionKind,
  { Icon: LucideIcon; accent: string; headerBg: string; amountColor: string }
> = {
  past_due_unpaid: {
    Icon: AlertTriangle,
    accent: 'border-red-300 dark:border-red-800',
    headerBg: 'bg-red-50 dark:bg-red-950/20',
    amountColor: 'text-red-600 dark:text-red-500',
  },
  stalled_partial: {
    Icon: Clock,
    accent: 'border-amber-300 dark:border-amber-800',
    headerBg: 'bg-amber-50 dark:bg-amber-950/15',
    amountColor: 'text-amber-700 dark:text-amber-500',
  },
  paid_no_bank_trail: {
    Icon: HelpCircle,
    accent: 'border-orange-300 dark:border-orange-800',
    headerBg: 'bg-orange-50 dark:bg-orange-950/15',
    amountColor: 'text-orange-700 dark:text-orange-500',
  },
  money_out_no_bill: {
    Icon: ArrowDownCircle,
    accent: 'border-purple-300 dark:border-purple-800',
    headerBg: 'bg-purple-50 dark:bg-purple-950/15',
    amountColor: 'text-purple-700 dark:text-purple-500',
  },
  recurring_unplanned: {
    Icon: RefreshCw,
    accent: 'border-blue-300 dark:border-blue-800',
    headerBg: 'bg-blue-50 dark:bg-blue-950/15',
    amountColor: 'text-blue-700 dark:text-blue-500',
  },
}

const EXCEPTION_ITEMS_CAP = 15

function ExceptionsPanel({ exceptions }: { exceptions: ExceptionGroup[] }) {
  // Explicit requirement: sorted by total descending. Empty groups (count 0)
  // are dropped — an empty category isn't an exception, and showing it would
  // be exactly the "dashboard ornament" this panel is designed not to be.
  const sorted = [...exceptions].filter((g) => g.count > 0).sort((a, b) => b.total - a.total)
  const grandTotal = sorted.reduce((sum, g) => sum + g.total, 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Exceptions
          </CardTitle>
          {sorted.length > 0 && (
            <span className="font-mono text-sm font-semibold text-red-600 dark:text-red-500">
              {formatMoney(grandTotal)}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Things that don&apos;t add up — a worklist to clear, not a dashboard ornament.
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Nothing outstanding — the books are clean.
          </div>
        ) : (
          sorted.map((group, i) => (
            <ExceptionGroupCard key={group.kind} group={group} defaultOpen={i === 0} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function ExceptionGroupCard({ group, defaultOpen }: { group: ExceptionGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = EXCEPTION_META[group.kind]
  const Icon = meta.Icon

  const sortedItems = [...group.items].sort((a, b) => b.amount - a.amount)
  const visibleItems = sortedItems.slice(0, EXCEPTION_ITEMS_CAP)
  const overflow = sortedItems.length - visibleItems.length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`rounded-lg border ${meta.accent} overflow-hidden`}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition-[filter] hover:brightness-[0.97] sm:px-4 ${meta.headerBg}`}
        >
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${meta.amountColor}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{group.title}</span>
              <Badge variant="outline" className="bg-background/70 px-1.5 py-0 text-[10px]">
                {group.count}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`font-mono text-sm font-bold sm:text-base ${meta.amountColor}`}>
              {formatMoney(group.total)}
            </span>
            {open ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t bg-background">
          {visibleItems.map((item) => (
            <ExceptionItemRow key={item.id} item={item} />
          ))}
          {overflow > 0 && (
            <div className="px-3.5 py-2 text-xs text-muted-foreground sm:px-4">
              Showing top {visibleItems.length} of {sortedItems.length}, by amount.
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ExceptionItemRow({ item }: { item: ExceptionItem }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5 sm:px-4">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{item.label}</div>
        {item.sublabel && <div className="truncate text-xs text-muted-foreground">{item.sublabel}</div>}
        <div className="mt-0.5 text-xs text-muted-foreground">
          {formatDateShort(item.date)}
          {item.ageDays !== null && (
            <span> · {item.ageDays} day{item.ageDays !== 1 ? 's' : ''} old</span>
          )}
        </div>
      </div>
      <div className="shrink-0 font-mono text-sm font-semibold">{formatMoney(item.amount)}</div>
    </div>
  )
}

// -----------------------------------------------------------------------
// Page header + skeleton
// -----------------------------------------------------------------------

function PageHeader({ asOfDate, isStale }: { asOfDate?: string; isStale?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Cash Board</h1>
        <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground">
          Read-only · Phase 0a
        </Badge>
      </div>
      {asOfDate && (
        <span className={`text-xs ${isStale ? 'font-medium text-amber-600 dark:text-amber-500' : 'text-muted-foreground'}`}>
          As of {format(parseISO(asOfDate), 'MMM d, yyyy')}
          {isStale && ' · stale'}
        </span>
      )}
    </div>
  )
}

function CashBoardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Card className="border-l-4 border-l-muted">
        <CardContent className="space-y-4 p-4 sm:p-6">
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-16 w-36" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-44" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// -----------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------

export default function CashBoardPage() {
  const router = useRouter()
  const { user, isLoading: authLoading, handleSessionError } = useAuth()

  const [data, setData] = useState<CashBoardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const userRole = user?.role ?? 'standard'
  const canManage = userRole === 'admin' || userRole === 'management'

  useEffect(() => {
    if (!authLoading && user && !canManage) {
      router.push('/dashboard')
    }
  }, [user, authLoading, canManage, router])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getCashBoard()
      if (!result.success || !result.data) {
        if (handleSessionError(result.error)) return
        setError(result.error ?? "Couldn't load the cash board. Try again.")
        return
      }
      setData(result.data)
    } catch (err) {
      console.error('Error loading cash board:', err)
      if (handleSessionError(err)) return
      setError("Couldn't load the cash board. Try again.")
    } finally {
      setLoading(false)
    }
  }, [handleSessionError])

  useEffect(() => {
    if (canManage) {
      fetchData()
    }
  }, [canManage, fetchData])

  if (loading || authLoading) {
    return <CashBoardSkeleton />
  }

  if (!canManage) {
    return null
  }

  if (error) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <ErrorState title="Unable to load the cash board" message={error} onRetry={fetchData} />
      </div>
    )
  }

  if (!data) {
    // fetchData always sets either data or error — this keeps the render
    // exhaustive rather than silently returning nothing.
    return (
      <div className="space-y-4">
        <PageHeader />
        <ErrorState
          title="No data"
          message="The cash board returned no data."
          onRetry={fetchData}
        />
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-5">
        <PageHeader asOfDate={data.asOfDate} isStale={data.isStale} />
        <Hero data={data} />
        <DecisionsPanel groups={data.decisionGroups} />
        <MoneyComingInPanel receivables={data.receivables} inflowForecast={data.inflowForecast} />
        <ExceptionsPanel exceptions={data.exceptions} />
      </div>
    </TooltipProvider>
  )
}
