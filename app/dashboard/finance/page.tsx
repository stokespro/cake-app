'use client'

import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowDownCircle,
  Banknote,
  Save,
  RefreshCw,
  Building2,
  XCircle,
  Plus,
  CreditCard,
  Link as LinkIcon,
} from 'lucide-react'
import { format, parseISO, startOfWeek, addDays } from 'date-fns'
import { getMonthSummary, getWeeklyBudget, syncBankFromSource, updateBill, getBillReviewDetail } from '@/actions/finance'
import { upsertCashSnapshot } from './_actions/snapshot'
import {
  runDailyReconciliation,
  getReconciliationLog,
  confirmReconciliationMatch,
  dismissReconciliationMatch,
  getUntrackedBankTransactions,
  getProposedTransactions,
  getMatchCandidates,
  assignReconciliationMatch,
} from './_actions/bank'
import type { MonthSummary, WeeklySummary, BillReviewDetail } from '@/actions/finance'
import type { ReconciliationLogRow, BankTransaction, ProposedTransaction, MatchCandidate } from './_actions/bank'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Separator } from '@/components/ui/separator'
import type { CashFlowResult, CashFlowEvent } from '@/lib/finance/cash-flow'
import {
  WeeklyBudgetView,
  WeeklyBudgetSkeleton,
} from './_components/weekly-budget-view'

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function getMonthLabel(month: string): string {
  return format(parseISO(month), 'MMMM yyyy')
}

function prevMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function nextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(year, mon, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function currentMonthStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

function last4(accountNumber: string): string {
  return accountNumber.slice(-4)
}

/**
 * Returns today's date as 'YYYY-MM-DD' in America/Chicago timezone.
 * Used for the staleness banner comparison so the cutoff is always midnight
 * Central regardless of where the browser is running.
 */
function getCentralToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// -----------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------

function CashFlowEventRow({
  event,
  isTrough,
}: {
  event: CashFlowEvent
  isTrough: boolean
}) {
  const isExcluded = event.runningBalance === undefined
  const isInflow = event.amount > 0
  const isPipeline = event.isPipeline

  let amountClass = ''
  let rowClass = ''

  if (isExcluded) {
    amountClass = 'text-muted-foreground line-through'
    rowClass = 'opacity-40'
  } else if (isPipeline) {
    amountClass = 'text-green-600/60'
  } else if (isInflow) {
    amountClass = 'text-green-600 font-medium'
  } else {
    amountClass = 'text-red-600 font-medium'
  }

  if (isTrough) {
    rowClass = 'bg-amber-50 dark:bg-amber-950/20'
  }

  return (
    <TableRow className={rowClass}>
      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground whitespace-nowrap">
        {format(parseISO(event.date), 'MMM d')}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          {isPipeline && <Clock className="h-3 w-3 text-muted-foreground shrink-0" />}
          <span className={`text-sm ${isPipeline ? 'text-muted-foreground italic' : ''}`}>
            {event.label}
          </span>
          {isTrough && (
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-400 ml-1">
              Low point
            </Badge>
          )}
        </div>
        {/* Mobile: show date and vendor as sub-text */}
        <div className="sm:hidden text-xs text-muted-foreground mt-0.5">
          {format(parseISO(event.date), 'MMM d')}
          {event.vendor && (
            <span className="ml-1">&middot; {event.vendor}</span>
          )}
        </div>
      </TableCell>
      {/* Vendor — hidden on mobile (surfaced as sub-text above), visible sm+ */}
      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
        {event.vendor ?? '—'}
      </TableCell>
      <TableCell className={`text-right text-sm ${amountClass}`}>
        {isExcluded ? '—' : `${isInflow ? '+' : ''}${formatMoney(event.amount)}`}
      </TableCell>
      <TableCell className="text-right text-sm font-mono">
        {event.runningBalance !== undefined ? (
          <span className={event.runningBalance < 0 ? 'text-red-600 font-semibold' : 'text-foreground'}>
            {formatMoney(event.runningBalance)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

// -----------------------------------------------------------------------
// ReconMatchBadge
// -----------------------------------------------------------------------

function ReconMatchBadge({ matchType }: { matchType: ReconciliationLogRow['match_type'] }) {
  switch (matchType) {
    case 'check_exact':
      return (
        <Badge variant="default" className="bg-green-600 text-xs">
          <CheckCircle className="h-3 w-3 mr-1" />
          Check match
        </Badge>
      )
    case 'check_amount_mismatch':
      return (
        <Badge variant="destructive" className="text-xs">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Amount mismatch
        </Badge>
      )
    case 'already_paid':
      return (
        <Badge variant="outline" className="text-xs">
          <CheckCircle className="h-3 w-3 mr-1" />
          Already paid
        </Badge>
      )
    case 'fuzzy_suggested':
      return (
        <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
          Fuzzy match
        </Badge>
      )
    case 'card_amount_vendor':
      return (
        <Badge variant="outline" className="text-xs text-blue-600 border-blue-400">
          <CreditCard className="h-3 w-3 mr-1" />
          Card/ACH match
        </Badge>
      )
    case 'amount_only':
      return (
        <Badge variant="outline" className="text-xs text-orange-600 border-orange-400">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Amount only — verify
        </Badge>
      )
    case 'already_paid_non_check':
      return (
        <Badge variant="outline" className="text-xs text-green-700 border-green-400">
          <CheckCircle className="h-3 w-3 mr-1" />
          Paid — link only
        </Badge>
      )
    case 'manual_override':
      return (
        <Badge variant="outline" className="text-xs text-purple-700 border-purple-400">
          <LinkIcon className="h-3 w-3 mr-1" />
          Manually matched
        </Badge>
      )
    default:
      return <Badge variant="outline" className="text-xs">{matchType}</Badge>
  }
}

// -----------------------------------------------------------------------
// BankBalancePanel
// -----------------------------------------------------------------------

function BankBalancePanel({
  summary,
  snapshotAmount,
  setSnapshotAmount,
  snapshotSaving,
  onSaveSnapshot,
  syncing,
  onSyncNow,
}: {
  summary: MonthSummary
  snapshotAmount: string
  setSnapshotAmount: (v: string) => void
  snapshotSaving: boolean
  onSaveSnapshot: () => void
  syncing: boolean
  onSyncNow: () => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const snap = summary.latestSnapshot
  const bank = summary.bankBalance
  const isBankSource = snap?.source === 'bank'

  // Staleness: compare bank as_of_date to today in America/Chicago.
  // If the bank balance is older than today, show a prominent warning banner.
  const centralToday = getCentralToday()
  const bankAsOf = bank?.as_of_date ?? null
  const isBankStale = bankAsOf ? bankAsOf < centralToday : false
  const daysOld = isBankStale && bankAsOf
    ? Math.round((Date.parse(centralToday) - Date.parse(bankAsOf)) / 86_400_000)
    : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Cash on Hand
          </CardTitle>
          <div className="flex items-center gap-2">
            {snap && (
              <Badge
                variant="outline"
                className={
                  isBankSource
                    ? 'text-xs text-blue-600 border-blue-300'
                    : 'text-xs text-muted-foreground'
                }
              >
                {isBankSource ? 'Synced from bank' : 'Manual entry'}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={onSyncNow}
              disabled={syncing}
              className="h-7 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync now'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Staleness banner — shown when bank as_of_date is before today (Central) */}
        {isBankStale && bankAsOf && (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Bank balance is from {format(parseISO(bankAsOf), 'MMM d')}
                {' '}&mdash;{' '}
                {daysOld} day{daysOld !== 1 ? 's' : ''} old
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                The scheduled BankSync pull may have failed. Use Sync now to pull fresh data.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onSyncNow}
              disabled={syncing}
              className="h-7 text-xs border-amber-400 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30 shrink-0"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync now'}
            </Button>
          </div>
        )}
        {/* Primary display */}
        {snap ? (
          <div>
            <div className="text-3xl font-bold">{formatMoney(snap.cash_on_hand)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {isBankSource ? (
                <>
                  Current balance (cash-flow anchor) &mdash; Regent Bank ****
                  {bank ? last4(bank.account_number) : '—'} as of{' '}
                  {bank ? format(parseISO(bank.as_of_date), 'MMM d, yyyy') : format(parseISO(snap.snapshot_date), 'MMM d, yyyy')}
                </>
              ) : (
                <>
                  Last recorded {format(parseISO(snap.snapshot_date), 'MMM d, yyyy')} &mdash;
                  update below to refresh projections
                </>
              )}
            </div>

            {/* Available + pending context — only shown when bank is source */}
            {isBankSource && bank && (
              <div className="flex items-center gap-4 mt-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Available</span>{' '}
                  <span className="font-medium">{formatMoney(bank.available)}</span>
                </div>
                {bank.pending !== 0 && (
                  <div>
                    <span className="text-muted-foreground">Pending</span>{' '}
                    <span className="font-medium text-amber-600">{formatMoney(bank.pending)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-amber-600 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            No cash snapshot yet. Set cash on hand below to enable projections.
          </div>
        )}

        {/* Manual override — collapsible when bank is source, always open otherwise */}
        {isBankSource ? (
          <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground px-0 h-auto">
                {manualOpen ? (
                  <ChevronUp className="h-3 w-3 mr-1" />
                ) : (
                  <ChevronDown className="h-3 w-3 mr-1" />
                )}
                Manual override
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 text-xs text-muted-foreground mb-2">
                Manually entering a value sets source to &quot;manual&quot; and prevents the nightly bank sync from overwriting it for today.
              </div>
              <ManualSnapshotInput
                snapshotAmount={snapshotAmount}
                setSnapshotAmount={setSnapshotAmount}
                snapshotSaving={snapshotSaving}
                onSave={onSaveSnapshot}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="space-y-2">
            {snap && (
              <p className="text-xs text-muted-foreground">
                Bank sync available — balance will auto-update at 7–8am Central when connected.
              </p>
            )}
            <ManualSnapshotInput
              snapshotAmount={snapshotAmount}
              setSnapshotAmount={setSnapshotAmount}
              snapshotSaving={snapshotSaving}
              onSave={onSaveSnapshot}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ManualSnapshotInput({
  snapshotAmount,
  setSnapshotAmount,
  snapshotSaving,
  onSave,
}: {
  snapshotAmount: string
  setSnapshotAmount: (v: string) => void
  snapshotSaving: boolean
  onSave: () => void
}) {
  return (
    <div className="flex items-center gap-3 max-w-sm">
      <div className="relative flex-1">
        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={snapshotAmount}
          onChange={(e) => setSnapshotAmount(e.target.value)}
          className="pl-8"
        />
      </div>
      <Button onClick={onSave} disabled={snapshotSaving || !snapshotAmount}>
        <Save className="h-4 w-4 mr-2" />
        {snapshotSaving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  )
}

// -----------------------------------------------------------------------
// matchTypeLabel — plain-English labels for the review sheet
// -----------------------------------------------------------------------

function matchTypeLabel(matchType: ReconciliationLogRow['match_type']): string {
  switch (matchType) {
    case 'check_exact':           return 'Matched by check number (exact)'
    case 'check_amount_mismatch': return 'Check number matched but amount differs'
    case 'already_paid':          return 'Bill already marked paid'
    case 'fuzzy_suggested':       return 'Fuzzy match — suggested for review'
    case 'card_amount_vendor':    return 'Matched by vendor keyword + amount'
    case 'amount_only':           return 'Matched on amount only — verify carefully'
    case 'already_paid_non_check': return 'Bill already marked paid — link to confirm'
    case 'untracked':             return 'No bill match found'
    case 'manual_override':       return 'Manually matched by a user'
    default:                      return matchType
  }
}

// -----------------------------------------------------------------------
// BillReviewSheet
// -----------------------------------------------------------------------

interface BillReviewSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: ReconciliationLogRow | null
  onConfirm: (logId: string) => Promise<void>
  onDismiss: (logId: string) => Promise<void>
  onAssigned: () => Promise<void>
  confirmingId: string | null
  dismissingId: string | null
}

function BillReviewSheet({
  open,
  onOpenChange,
  row,
  onConfirm,
  onDismiss,
  onAssigned,
  confirmingId,
  dismissingId,
}: BillReviewSheetProps) {
  const [detail, setDetail] = useState<BillReviewDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // "Not the right bill?" candidate search state
  const [candidatesOpen, setCandidatesOpen] = useState(false)
  const [candidates, setCandidates] = useState<MatchCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidatesError, setCandidatesError] = useState<string | null>(null)
  const [candidateSearch, setCandidateSearch] = useState('')
  const [assigningId, setAssigningId] = useState<string | null>(null)

  // Load bill detail whenever a new row is selected
  useEffect(() => {
    if (!open || !row?.bill_id) {
      setDetail(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    getBillReviewDetail(row.bill_id).then((res) => {
      if (res.success && res.data) {
        setDetail(res.data)
      } else {
        setError(res.error ?? 'Failed to load bill detail')
      }
      setLoading(false)
    })
  }, [open, row?.bill_id])

  // Reset the candidate-search section whenever a new row is selected or the
  // sheet closes — it should never carry stale state between bank transactions.
  useEffect(() => {
    setCandidatesOpen(false)
    setCandidates([])
    setCandidatesLoading(false)
    setCandidatesError(null)
    setCandidateSearch('')
  }, [open, row?.id])

  // Lazy-load candidates only once the section is expanded, then re-query
  // (debounced) whenever the search term changes.
  //
  // `cancelled` guards against two stale-response races:
  //   1. Across transactions: open txn A, expand, close before A's response
  //      lands, open txn B — A's late response must not overwrite B's list
  //      (or worse, let "Use this match" apply A's bill id against B's txn).
  //   2. Within one transaction's search box: "acme" resolving after "acme
  //      power" (a later, more specific search) must not clobber it.
  // Every request this effect fires is either superseded by a later run of
  // this same effect (new deps → cleanup sets cancelled=true) or by the
  // section collapsing/closing (same cleanup path).
  useEffect(() => {
    if (!open || !row?.id || !candidatesOpen) {
      setCandidatesLoading(false)
      return
    }
    const logId = row.id
    const term = candidateSearch.trim()
    let cancelled = false
    setCandidatesLoading(true)
    setCandidatesError(null)
    const timer = setTimeout(() => {
      getMatchCandidates(logId, term ? { search: term } : undefined)
        .then((res) => {
          if (cancelled) return
          if (res.success) {
            setCandidates(res.data ?? [])
          } else {
            setCandidatesError(res.error ?? 'Failed to load candidates')
            toast.error(res.error ?? 'Failed to load match candidates')
          }
        })
        .catch((err) => {
          if (cancelled) return
          console.error('getMatchCandidates error:', err)
          setCandidatesError('Failed to load candidates')
          toast.error('Failed to load match candidates')
        })
        .finally(() => {
          if (!cancelled) setCandidatesLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, row?.id, candidatesOpen, candidateSearch])

  if (!row) return null

  const isLinkOnly = row.match_type === 'already_paid_non_check'
  const canConfirm =
    row.match_type === 'check_amount_mismatch' ||
    row.match_type === 'already_paid' ||
    row.match_type === 'card_amount_vendor' ||
    row.match_type === 'amount_only' ||
    row.match_type === 'already_paid_non_check'

  const isConfirming = confirmingId === row.id
  const isDismissing = dismissingId === row.id

  const bill = detail?.bill ?? null
  const siblings = detail?.siblings ?? []

  const handleAssign = async (candidateId: string) => {
    setAssigningId(candidateId)
    try {
      const result = await assignReconciliationMatch(row.id, candidateId)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to assign match')
        // BUG-3 fix: 'auto_applied_conflict' and 'bank_txn_spent' both mean
        // our view is stale — someone else (a cron run or another user)
        // already reconciled this bill or this bank transaction between page
        // load and this click. Refresh the underlying list and close rather
        // than leaving the user staring at data that's now wrong.
        // NEW-1 addition: 'not_pending' joins this list too — the RPC's
        // lock-ordering fix (advisory lock before row lock, to eliminate a
        // real deadlock under concurrent assigns) means the LOSER of a race
        // between two concurrent assigns on the same bank transaction now
        // surfaces as 'not_pending' (the winner's both-sides dismissal flips
        // the loser's row status before the loser re-reads it), not
        // 'bank_txn_spent'. Same stale-view situation, same handling.
        if (
          result.errorCode === 'auto_applied_conflict' ||
          result.errorCode === 'bank_txn_spent' ||
          result.errorCode === 'not_pending'
        ) {
          await onAssigned()
          onOpenChange(false)
        }
        return
      }
      toast.success('Match assigned')
      await onAssigned()
      onOpenChange(false)
    } catch (err) {
      console.error('Assign match error:', err)
      toast.error('Failed to assign match')
    } finally {
      setAssigningId(null)
    }
  }

  function daysFromTxnLabel(days: number): string {
    if (days === 0) return 'due same day'
    if (days > 0) return `due ${days} day${days !== 1 ? 's' : ''} after`
    return `due ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''} before`
  }

  function DetailRow({ label, value }: { label: string; value: ReactNode }) {
    if (!value && value !== 0) return null
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm">{value}</span>
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] flex flex-col p-0"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="text-base">
            {bill ? bill.name : (row.bill_name ?? 'Bill Review')}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Review this match before confirming or dismissing
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {loading && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading bill detail...
            </div>
          )}

          {error && (
            <div className="py-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && (
            <>
              {/* ---- Bank side ---- */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Bank Transaction
                </h3>
                <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <DetailRow
                    label="Description"
                    value={row.bank_description ?? '—'}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <DetailRow
                      label="Amount"
                      value={
                        row.bank_amount !== null
                          ? <span className="font-mono font-medium">{formatMoney(Math.abs(row.bank_amount))}</span>
                          : '—'
                      }
                    />
                    <DetailRow
                      label="Date"
                      value={row.bank_date ? format(parseISO(row.bank_date), 'MMM d, yyyy') : '—'}
                    />
                  </div>
                  <DetailRow
                    label="Match type"
                    value={matchTypeLabel(row.match_type)}
                  />
                  {row.suggested_payment_method && (
                    <DetailRow
                      label="Suggested method"
                      value={<span className="capitalize">{row.suggested_payment_method}</span>}
                    />
                  )}
                </div>
              </div>

              <Separator />

              {/* ---- Bill side ---- */}
              {bill ? (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Matched Bill
                  </h3>

                  {/* Status + QB badge row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant={
                        bill.status === 'paid'
                          ? 'default'
                          : bill.status === 'void'
                            ? 'secondary'
                            : 'outline'
                      }
                      className={`text-xs ${bill.status === 'paid' ? 'bg-green-600' : bill.status === 'partial' ? 'text-amber-700 border-amber-400' : ''}`}
                    >
                      {bill.status.charAt(0).toUpperCase() + bill.status.slice(1)}
                    </Badge>
                    {bill.template_name && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        From template
                      </Badge>
                    )}
                    {bill.from_quickbooks && (
                      <Badge variant="outline" className="text-xs text-blue-600 border-blue-300">
                        Imported from QuickBooks
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-2">
                    {bill.vendor_name && (
                      <DetailRow label="Vendor" value={bill.vendor_name} />
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <DetailRow
                        label="Bill amount"
                        value={<span className="font-mono">{formatMoney(bill.amount)}</span>}
                      />
                      <DetailRow
                        label="Amount paid"
                        value={
                          bill.amount_paid > 0
                            ? <span className="font-mono text-green-700">{formatMoney(bill.amount_paid)}</span>
                            : <span className="text-muted-foreground">$0.00</span>
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <DetailRow
                        label="Due date"
                        value={format(parseISO(bill.due_date), 'MMM d, yyyy')}
                      />
                      <DetailRow
                        label="Period"
                        value={format(parseISO(bill.period_month), 'MMMM yyyy')}
                      />
                    </div>
                    {bill.paid_date && (
                      <DetailRow
                        label="Paid date"
                        value={format(parseISO(bill.paid_date), 'MMM d, yyyy')}
                      />
                    )}
                    {bill.payment_method && (
                      <DetailRow
                        label="Payment method"
                        value={<span className="capitalize">{bill.payment_method}</span>}
                      />
                    )}
                    {bill.payment_ref && (
                      <DetailRow label="Payment ref" value={bill.payment_ref} />
                    )}
                    {bill.notes && (
                      <DetailRow label="Notes" value={bill.notes} />
                    )}
                  </div>
                </div>
              ) : (
                !loading && (
                  <div className="text-sm text-muted-foreground italic">
                    {row.bill_id ? 'Loading bill...' : 'No bill linked to this match'}
                  </div>
                )
              )}

              <Separator />

              {/* ---- Not the right bill? — pick a different bill to match ---- */}
              <Collapsible
                open={candidatesOpen}
                onOpenChange={(nextOpen) => {
                  // Don't let the section collapse mid-assignment — that would
                  // unmount the row the user just tapped while its request is
                  // still in flight.
                  if (assigningId !== null) return
                  setCandidatesOpen(nextOpen)
                }}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    disabled={assigningId !== null}
                    className="flex items-center justify-between w-full min-h-11 py-2 text-sm font-medium disabled:opacity-60"
                  >
                    <span>Not the right bill?</span>
                    {candidatesOpen ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-3">
                  <p className="text-xs text-muted-foreground">
                    Search all bills, or pick from bills that match this transaction&apos;s amount and are due within 45 days.
                  </p>
                  <Input
                    placeholder="Search all bills by name or vendor..."
                    value={candidateSearch}
                    onChange={(e) => setCandidateSearch(e.target.value)}
                    disabled={assigningId !== null}
                  />
                  {candidateSearch.trim() && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Searching all bills — outside the safe amount/date window. Double-check before assigning.
                    </p>
                  )}

                  {candidatesLoading && (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      Searching...
                    </div>
                  )}

                  {!candidatesLoading && candidatesError && (
                    <div className="py-2 text-xs text-destructive">{candidatesError}</div>
                  )}

                  {!candidatesLoading && !candidatesError && candidates.length === 0 && (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      {candidateSearch.trim()
                        ? 'No bills match that search.'
                        : 'No other bills match this amount and date range — try searching all bills.'}
                    </div>
                  )}

                  {!candidatesLoading && !candidatesError && candidates.length > 0 && (
                    <div className="rounded-md border divide-y">
                      {candidates.map((c) => (
                        <div key={c.id} className="px-3 py-2 flex items-start justify-between gap-2">
                          <div className="min-w-0 space-y-0.5">
                            <div className="text-sm font-medium truncate">{c.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {c.vendor_name && <span>{c.vendor_name} &middot; </span>}
                              Due {format(parseISO(c.due_date), 'MMM d, yyyy')} ({daysFromTxnLabel(c.days_from_txn)})
                            </div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`text-xs font-mono ${c.amount_matches ? 'text-green-700' : ''}`}>
                                {formatMoney(c.amount)}
                              </span>
                              {c.amount_matches && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 text-green-700 border-green-300">
                                  Amount matches
                                </Badge>
                              )}
                              {c.status === 'paid' ? (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 text-blue-700 border-blue-300">
                                  Paid — link only, no new payment
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 capitalize">
                                  {c.status}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs shrink-0"
                            disabled={assigningId !== null}
                            onClick={() => handleAssign(c.id)}
                          >
                            {assigningId === c.id ? 'Assigning...' : 'Use this match'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* ---- Duplicate warning (read-only — NOT a match picker; use
                     "Not the right bill?" above to actually reassign) ---- */}
              {siblings.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span className="text-sm font-medium">
                        Duplicate check — {siblings.length} other bill{siblings.length !== 1 ? 's' : ''} in the system also
                        total{siblings.length === 1 ? 's' : ''} {bill ? formatMoney(bill.amount) : ''}. These are not match
                        suggestions.
                      </span>
                    </div>
                    <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 divide-y divide-amber-100 dark:divide-amber-900">
                      {siblings.map((s) => (
                        <div key={s.id} className="px-3 py-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{s.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {s.vendor_name && <span>{s.vendor_name} &middot; </span>}
                              Due {format(parseISO(s.due_date), 'MMM d, yyyy')}
                            </div>
                          </div>
                          <Badge
                            variant="outline"
                            className={`text-xs shrink-0 ${
                              s.status === 'paid'
                                ? 'text-green-700 border-green-300'
                                : s.status === 'partial'
                                  ? 'text-amber-700 border-amber-400'
                                  : ''
                            }`}
                          >
                            {s.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ---- Footer actions ---- */}
        <SheetFooter className="px-6 py-4 border-t gap-2 flex-row sm:flex-row">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground"
            disabled={isDismissing || isConfirming}
            onClick={async () => {
              await onDismiss(row.id)
              onOpenChange(false)
            }}
          >
            <XCircle className="h-3.5 w-3.5 mr-1.5" />
            {isDismissing ? 'Dismissing...' : 'Dismiss'}
          </Button>
          <div className="flex-1" />
          {canConfirm && (
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={isConfirming || isDismissing}
              onClick={async () => {
                await onConfirm(row.id)
                onOpenChange(false)
              }}
            >
              {isLinkOnly ? (
                <>
                  <LinkIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isConfirming ? 'Linking...' : 'Link'}
                </>
              ) : (
                <>
                  <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                  {isConfirming ? 'Confirming...' : 'Confirm'}
                </>
              )}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// -----------------------------------------------------------------------
// ReconciliationPanel
// -----------------------------------------------------------------------

function ReconciliationPanel() {
  const [reconciling, setReconciling] = useState(false)
  const [pendingRows, setPendingRows] = useState<ReconciliationLogRow[]>([])
  const [clearedRows, setClearedRows] = useState<ReconciliationLogRow[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('pending')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)

  // Review sheet state
  const [reviewSheetOpen, setReviewSheetOpen] = useState(false)
  const [reviewRow, setReviewRow] = useState<ReconciliationLogRow | null>(null)

  const fetchLog = useCallback(async () => {
    setLogLoading(true)
    try {
      const [pendingRes, clearedRes] = await Promise.all([
        getReconciliationLog('pending'),
        getReconciliationLog('cleared'),
      ])
      if (pendingRes.success) setPendingRows(pendingRes.data ?? [])
      if (clearedRes.success) setClearedRows(clearedRes.data ?? [])
    } catch (err) {
      console.error('Error fetching reconciliation log:', err)
    } finally {
      setLogLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  const handleReconcile = async () => {
    setReconciling(true)
    try {
      const result = await runDailyReconciliation()
      if (!result.success || !result.data) {
        toast.error(result.error ?? 'Reconciliation failed')
        return
      }
      const { check_auto_applied, check_mismatch, noncheck_proposed } = result.data
      const parts: string[] = []
      if (check_auto_applied > 0)
        parts.push(`${check_auto_applied} check${check_auto_applied !== 1 ? 's' : ''} auto-paid`)
      if (check_mismatch > 0)
        parts.push(`${check_mismatch} check${check_mismatch !== 1 ? 's' : ''} need review`)
      if (noncheck_proposed > 0)
        parts.push(`${noncheck_proposed} non-check${noncheck_proposed !== 1 ? 's' : ''} proposed`)
      toast.success(parts.length > 0 ? parts.join(', ') : 'No new items to reconcile')
      await fetchLog()
    } catch (err) {
      console.error('Reconciliation error:', err)
      toast.error('Reconciliation failed')
    } finally {
      setReconciling(false)
    }
  }

  const handleConfirm = async (logId: string) => {
    setConfirmingId(logId)
    try {
      const result = await confirmReconciliationMatch(logId)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to confirm')
        return
      }
      toast.success('Match confirmed')
      await fetchLog()
    } catch (err) {
      console.error('Confirm error:', err)
      toast.error('Failed to confirm')
    } finally {
      setConfirmingId(null)
    }
  }

  const handleDismiss = async (logId: string) => {
    setDismissingId(logId)
    try {
      const result = await dismissReconciliationMatch(logId)
      if (!result.success) {
        toast.error(result.error ?? 'Failed to dismiss')
        return
      }
      toast.success('Match dismissed')
      await fetchLog()
    } catch (err) {
      console.error('Dismiss error:', err)
      toast.error('Failed to dismiss')
    } finally {
      setDismissingId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Check Reconciliation
            {pendingRows.length > 0 && (
              <Badge variant="destructive" className="text-xs">
                {pendingRows.length} pending
              </Badge>
            )}
          </CardTitle>
          <Button
            size="sm"
            onClick={handleReconcile}
            disabled={reconciling}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${reconciling ? 'animate-spin' : ''}`} />
            {reconciling ? 'Running...' : 'Reconcile Now'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Matches cleared checks automatically by check number; proposes card/ACH/wire matches for human review.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="px-4 pb-2">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="pending" className="flex-1 sm:flex-none">
                Pending Review
                {pendingRows.length > 0 && (
                  <span className="ml-1.5 text-xs bg-destructive text-destructive-foreground rounded-full px-1.5 py-0.5 leading-none">
                    {pendingRows.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="cleared" className="flex-1 sm:flex-none">
                Recently Cleared
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="pending" className="mt-0">
            {logLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
            ) : pendingRows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 opacity-40" />
                No items pending review
              </div>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[90px] hidden sm:table-cell">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="hidden md:table-cell">Matched Bill</TableHead>
                      <TableHead className="text-right">Bank Amt</TableHead>
                      <TableHead className="hidden md:table-cell text-right">Bill Amt</TableHead>
                      <TableHead className="hidden sm:table-cell">Type</TableHead>
                      <TableHead className="hidden lg:table-cell">Method</TableHead>
                      <TableHead className="text-right w-[140px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingRows.map((row) => {
                      const isLinkOnly = row.match_type === 'already_paid_non_check'
                      const canConfirm =
                        row.match_type === 'check_amount_mismatch' ||
                        row.match_type === 'already_paid' ||
                        row.match_type === 'card_amount_vendor' ||
                        row.match_type === 'amount_only' ||
                        row.match_type === 'already_paid_non_check'
                      return (
                      <TableRow key={row.id}>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground whitespace-nowrap">
                          {row.bank_date ? format(parseISO(row.bank_date), 'MMM d, yyyy') : '—'}
                        </TableCell>
                        <TableCell className="text-sm max-w-[180px]">
                          <span className="truncate block">{row.bank_description ?? '—'}</span>
                          {/* Mobile: show date, matched bill, and type as sub-text */}
                          <div className="sm:hidden text-xs text-muted-foreground mt-0.5 space-y-0.5">
                            {row.bank_date && (
                              <span className="block">{format(parseISO(row.bank_date), 'MMM d, yyyy')}</span>
                            )}
                            {row.bill_id && row.bill_name && (
                              <button
                                type="button"
                                className="block text-left underline underline-offset-2 decoration-dashed"
                                onClick={() => {
                                  setReviewRow(row)
                                  setReviewSheetOpen(true)
                                }}
                              >
                                {row.bill_name}
                              </button>
                            )}
                          </div>
                          <div className="md:hidden mt-1">
                            <ReconMatchBadge matchType={row.match_type} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm">
                          {row.bill_id ? (
                            <button
                              type="button"
                              className="text-left underline underline-offset-2 decoration-dashed hover:text-primary transition-colors"
                              onClick={() => {
                                setReviewRow(row)
                                setReviewSheetOpen(true)
                              }}
                            >
                              {row.bill_name ?? 'View bill'}
                            </button>
                          ) : (
                            <span className="text-muted-foreground italic">No bill</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.bank_amount !== null ? formatMoney(Math.abs(row.bank_amount)) : '—'}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-right text-sm font-mono">
                          {row.bill_amount !== null ? formatMoney(row.bill_amount) : '—'}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <ReconMatchBadge matchType={row.match_type} />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground capitalize">
                          {row.suggested_payment_method ?? '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {canConfirm && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                disabled={confirmingId === row.id}
                                onClick={() => handleConfirm(row.id)}
                              >
                                {isLinkOnly ? (
                                  <>
                                    <LinkIcon className="h-3 w-3 mr-1" />
                                    {confirmingId === row.id ? '...' : 'Link'}
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                    {confirmingId === row.id ? '...' : 'Confirm'}
                                  </>
                                )}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-muted-foreground"
                              disabled={dismissingId === row.id}
                              onClick={() => handleDismiss(row.id)}
                            >
                              <XCircle className="h-3 w-3 mr-1" />
                              {dismissingId === row.id ? '...' : 'Dismiss'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="cleared" className="mt-0">
            {logLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
            ) : clearedRows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No cleared checks in the last 30 days
              </div>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="hidden sm:table-cell w-[90px]">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="hidden sm:table-cell">Bill</TableHead>
                      <TableHead className="text-right">Bank Amt</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {clearedRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground whitespace-nowrap">
                          {row.bank_date ? format(parseISO(row.bank_date), 'MMM d, yyyy') : '—'}
                        </TableCell>
                        <TableCell className="text-sm max-w-[180px]">
                          <span className="truncate block">{row.bank_description ?? '—'}</span>
                          {/* Mobile: show date and bill as sub-text */}
                          <div className="sm:hidden text-xs text-muted-foreground mt-0.5 space-y-0.5">
                            {row.bank_date && (
                              <span className="block">{format(parseISO(row.bank_date), 'MMM d, yyyy')}</span>
                            )}
                            {row.bill_name && <span className="block">{row.bill_name}</span>}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm">
                          {row.bill_name ?? <span className="text-muted-foreground italic">—</span>}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.bank_amount !== null ? formatMoney(Math.abs(row.bank_amount)) : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={row.status === 'auto_applied' ? 'default' : 'outline'}
                            className={`text-xs ${row.status === 'auto_applied' ? 'bg-green-600' : ''}`}
                          >
                            {row.status === 'auto_applied' ? 'Auto-paid' : 'Confirmed'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Bill review side panel */}
      <BillReviewSheet
        open={reviewSheetOpen}
        onOpenChange={setReviewSheetOpen}
        row={reviewRow}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        onAssigned={fetchLog}
        confirmingId={confirmingId}
        dismissingId={dismissingId}
      />
    </Card>
  )
}

// -----------------------------------------------------------------------
// UntrackedExpensesPanel
// -----------------------------------------------------------------------

function UntrackedExpensesPanel({
  month,
  onCreateBill,
}: {
  month: string
  /** Receives the whole bank transaction — the bills page needs its bs_id and
   *  description to prefill the create sheet and auto-reconcile on save. */
  onCreateBill: (txn: BankTransaction) => void
}) {
  const [open, setOpen] = useState(false)
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [proposed, setProposed] = useState<ProposedTransaction[]>([])
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  const fetchUntracked = useCallback(async () => {
    setLoading(true)
    try {
      const [untrackedRes, proposedRes] = await Promise.all([
        getUntrackedBankTransactions(month),
        getProposedTransactions(month),
      ])
      if (untrackedRes.success) setTransactions(untrackedRes.data ?? [])
      if (proposedRes.success) setProposed(proposedRes.data ?? [])
    } catch (err) {
      console.error('Error fetching untracked transactions:', err)
    } finally {
      setLoading(false)
      setFetched(true)
    }
  }, [month])

  // Re-fetch when month changes (reset fetched so the panel reloads on next open,
  // or immediately if already open)
  useEffect(() => {
    setFetched(false)
    setTransactions([])
    setProposed([])
    if (open) {
      fetchUntracked()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month])

  // Fetch once when opened
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && !fetched) {
      fetchUntracked()
    }
  }

  // Build a set of bs_ids that have a pending_review proposal — these render muted
  const proposedBsIds = new Set(proposed.map((p) => p.bank_bs_id))
  const totalCount = transactions.length + proposed.filter((p) => !transactions.some((t) => t.bs_id === p.bank_bs_id)).length

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          <span className="flex items-center gap-2">
            <ArrowDownCircle className="h-4 w-4" />
            Untracked Bank Expenses
            {totalCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {totalCount}
              </Badge>
            )}
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Untracked Expenses</CardTitle>
            <p className="text-xs text-muted-foreground">
              Outflows from Regent Bank not yet matched to a bill. Use &quot;Create Bill&quot; to record them.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
            ) : transactions.length === 0 && proposed.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 opacity-40" />
                All bank outflows are accounted for
              </div>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="hidden sm:table-cell w-[90px]">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="w-[150px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((txn) => {
                      const hasProposal = proposedBsIds.has(txn.bs_id)
                      return (
                        <TableRow key={txn.bs_id} className={hasProposal ? 'opacity-60' : undefined}>
                          <TableCell className="hidden sm:table-cell text-xs text-muted-foreground whitespace-nowrap">
                            {format(parseISO(txn.txn_date), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className="text-sm max-w-[220px]">
                            <span className="truncate block">{txn.description}</span>
                            {txn.merchant_name && txn.merchant_name !== txn.description && (
                              <span className="text-xs text-muted-foreground">{txn.merchant_name}</span>
                            )}
                            {/* Mobile: show date as sub-text */}
                            <div className="sm:hidden text-xs text-muted-foreground mt-0.5">
                              {format(parseISO(txn.txn_date), 'MMM d, yyyy')}
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm font-mono text-red-600 font-medium">
                            {formatMoney(Math.abs(txn.amount))}
                          </TableCell>
                          <TableCell className="text-right">
                            {hasProposal ? (
                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                Match proposed — see reconciliation
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => onCreateBill(txn)}
                              >
                                <Plus className="h-3 w-3 mr-1" />
                                Create Bill
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  )
}

// -----------------------------------------------------------------------
// Main page
// -----------------------------------------------------------------------

export default function FinanceOverviewPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  const [viewMode, setViewMode] = useState<'month' | 'week'>('month')
  const [month, setMonth] = useState(currentMonthStr())
  const [summary, setSummary] = useState<MonthSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPipeline, setShowPipeline] = useState(false)

  // Weekly budget state
  const [weeklyData, setWeeklyData] = useState<WeeklySummary | null>(null)
  const [weeklyLoading, setWeeklyLoading] = useState(false)
  const [showPipelineWeekly, setShowPipelineWeekly] = useState(false)

  // Cash snapshot input
  const [snapshotAmount, setSnapshotAmount] = useState('')
  const [snapshotSaving, setSavingSnapshot] = useState(false)

  // Manual bank sync
  const [syncing, setSyncing] = useState(false)

  const userRole = user?.role ?? 'standard'
  const canManage = userRole === 'admin' || userRole === 'management'

  useEffect(() => {
    if (!authLoading && user && !canManage) {
      router.push('/dashboard')
    }
  }, [user, authLoading, canManage, router])

  useEffect(() => {
    if (canManage) {
      fetchSummary()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, month])

  useEffect(() => {
    if (canManage && viewMode === 'week') {
      fetchWeekly()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, viewMode])

  const fetchWeekly = async () => {
    setWeeklyLoading(true)
    try {
      const result = await getWeeklyBudget({ weeks: 6 })
      if (!result.success || !result.data) {
        toast.error(result.error ?? 'Failed to load weekly budget data')
        return
      }
      setWeeklyData(result.data)
    } catch (err) {
      console.error('Error fetching weekly budget:', err)
      toast.error('Failed to load weekly budget data')
    } finally {
      setWeeklyLoading(false)
    }
  }

  const handleMoveBill = async (billId: string, planned_pay_date: string | null) => {
    const result = await updateBill(billId, { planned_pay_date })
    if (!result.success) {
      toast.error(result.error ?? 'Failed to move bill')
      return
    }
    await fetchWeekly()
  }

  const fetchSummary = async () => {
    setLoading(true)
    try {
      const result = await getMonthSummary(month)
      if (!result.success || !result.data) {
        toast.error(result.error ?? 'Failed to load finance data')
        return
      }
      setSummary(result.data)
      if (result.data.latestSnapshot) {
        setSnapshotAmount(String(result.data.latestSnapshot.cash_on_hand))
      } else {
        setSnapshotAmount('')
      }
    } catch (err) {
      console.error('Error fetching finance summary:', err)
      toast.error('Failed to load finance data')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveSnapshot = async () => {
    const amount = parseFloat(snapshotAmount)
    if (isNaN(amount)) {
      toast.error('Please enter a valid amount')
      return
    }
    setSavingSnapshot(true)
    try {
      const today = new Date().toISOString().substring(0, 10)
      const result = await upsertCashSnapshot({
        snapshot_date: today,
        cash_on_hand: amount,
        recorded_by: user?.id,
      })
      if (!result.success) {
        toast.error(result.error ?? 'Failed to save snapshot')
        return
      }
      toast.success('Cash snapshot saved')
      await fetchSummary()
    } catch (err) {
      console.error('Error saving snapshot:', err)
      toast.error('Failed to save snapshot')
    } finally {
      setSavingSnapshot(false)
    }
  }

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      const result = await syncBankFromSource()
      if (!result.success) {
        const errMsg =
          result.errors.length > 0 ? result.errors.join('; ') : 'Sync failed'
        toast.error(errMsg)
        // Still refresh summary — partial success may have written a snapshot
        await fetchSummary()
        return
      }
      const cashStr =
        result.cashOnHand != null ? ` — balance: ${formatMoney(result.cashOnHand)}` : ''
      toast.success(`Bank synced${cashStr}`)
      await fetchSummary()
    } catch (err) {
      console.error('Error syncing bank:', err)
      toast.error('Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  // Navigate to the bills page with a pre-filled one-off bill via URL params.
  // The bills page opens its create sheet from these on mount, and on save
  // links the new bill back to this bank transaction (prefill_bs_id) so the
  // transaction stops showing as untracked. URLSearchParams handles encoding.
  const handleCreateBillFromTransaction = (txn: BankTransaction) => {
    const params = new URLSearchParams({
      prefill_name: txn.merchant_name ?? txn.description,
      prefill_amount: String(Math.abs(txn.amount)),
      prefill_due_date: txn.txn_date,
      prefill_bs_id: String(txn.bs_id),
      // Raw bank description — used to derive the payment method / check number.
      prefill_desc: txn.description,
      // What the bill's notes get seeded with.
      prefill_memo: txn.original_description ?? txn.description,
    })
    router.push(`/dashboard/finance/bills?${params.toString()}`)
  }

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading finance data...</div>
      </div>
    )
  }

  if (!canManage) {
    return null
  }

  const cashFlow: CashFlowResult | null = summary?.cashFlow
    ? showPipeline
      ? summary.cashFlow.withPipeline
      : summary.cashFlow.realized
    : null

  const troughId = cashFlow?.troughEvent?.id ?? null

  const nonVoidBills = summary?.bills.filter((b) => b.status !== 'void') ?? []
  const totalBills = nonVoidBills.reduce((s, b) => s + b.amount, 0)
  const totalPaid = nonVoidBills.reduce((s, b) => s + b.amount_paid, 0)
  const unpaidBills = totalBills - totalPaid

  // Compute week1Start label for week mode header
  const todayDate = new Date()
  const week1StartDate = startOfWeek(todayDate, { weekStartsOn: 1 })
  const week6EndDate = addDays(week1StartDate, 41) // 6 weeks - 1 day
  const weekRangeLabel = `${format(week1StartDate, 'MMM d')} – ${format(week6EndDate, 'MMM d, yyyy')}`

  return (
    <div className="space-y-6">
      {/* Header with month picker / week toggle */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Finance Overview</h1>
          <p className="text-muted-foreground mt-1">
            {viewMode === 'week'
              ? `Rolling 6 weeks from ${weekRangeLabel}`
              : `Cash position, revenue, and bills for ${getMonthLabel(month)}`
            }
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Month | Week toggle */}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <Button
              variant={viewMode === 'month' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none border-0 h-8 px-3 text-xs"
              onClick={() => setViewMode('month')}
            >
              Month
            </Button>
            <Button
              variant={viewMode === 'week' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none border-0 border-l h-8 px-3 text-xs"
              onClick={() => setViewMode('week')}
            >
              Week
            </Button>
          </div>

          {/* Month nav — only shown in month mode */}
          {viewMode === 'month' && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setMonth(prevMonth(month))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium min-w-[140px] text-center">
                {getMonthLabel(month)}
              </span>
              <Button variant="outline" size="icon" onClick={() => setMonth(nextMonth(month))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              {month !== currentMonthStr() && (
                <Button variant="ghost" size="sm" onClick={() => setMonth(currentMonthStr())}>
                  Today
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Headline cards — month mode only */}
      {viewMode === 'month' && <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Revenue */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div>
              <div className="text-2xl font-bold">
                {formatMoney(summary?.realizedRevenue ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">Delivered (realized)</div>
            </div>
            {(summary?.pipelineRevenue ?? 0) > 0 && (
              <div className="border-t pt-2">
                <div className="text-lg font-semibold text-muted-foreground">
                  + {formatMoney(summary?.pipelineRevenue ?? 0)}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Pipeline (expected)
                </div>
                <div className="mt-1 space-y-0.5 pl-4 text-xs text-muted-foreground">
                  <div>Non-terms {formatMoney(summary?.pipelineNonTerms ?? 0)}</div>
                  <div>Terms {formatMoney(summary?.pipelineTerms ?? 0)}</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Total Bills */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Bills This Month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-bold">{formatMoney(totalBills)}</div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="text-green-600">{formatMoney(totalPaid)} paid</span>
              {unpaidBills > 0 && (
                <span className="text-red-600">{formatMoney(unpaidBills)} remaining</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Cash Needed / Trough */}
        <Card
          className={
            cashFlow && cashFlow.troughBalance < 0
              ? 'border-red-300 dark:border-red-800'
              : ''
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ArrowDownCircle className="h-4 w-4" />
              Cash Position (Trough)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!summary?.latestSnapshot ? (
              <div className="text-sm text-muted-foreground">
                Set cash on hand below to see projection
              </div>
            ) : !cashFlow ? (
              <div className="text-sm text-muted-foreground">No cash-flow data</div>
            ) : cashFlow.troughBalance < 0 ? (
              <>
                <div className="text-2xl font-bold text-red-600">
                  {formatMoney(cashFlow.troughBalance)}
                </div>
                <div className="flex items-center gap-1 text-sm text-red-600 mt-1">
                  <AlertTriangle className="h-4 w-4" />
                  Gap: {formatMoney(cashFlow.cashGap)}
                  {cashFlow.troughDate && (
                    <span className="text-muted-foreground ml-1">
                      by {format(parseISO(cashFlow.troughDate), 'MMM d')}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold text-green-600">
                  {formatMoney(cashFlow.troughBalance)}
                </div>
                <div className="flex items-center gap-1 text-sm text-green-600 mt-1">
                  <CheckCircle className="h-4 w-4" />
                  Covered
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>}

      {/* Bank Balance / Cash on Hand panel — always visible */}
      {summary && (
        <BankBalancePanel
          summary={summary}
          snapshotAmount={snapshotAmount}
          setSnapshotAmount={setSnapshotAmount}
          snapshotSaving={snapshotSaving}
          onSaveSnapshot={handleSaveSnapshot}
          syncing={syncing}
          onSyncNow={handleSyncNow}
        />
      )}

      {/* Reconciliation panel */}
      {user && (
        <ReconciliationPanel />
      )}

      {/* Weekly budget view — week mode only */}
      {viewMode === 'week' && (
        <div className="space-y-4">
          {/* Weekly pipeline toggle */}
          <div className="flex items-center gap-2">
            <Label
              htmlFor="weekly-pipeline-toggle"
              className="text-sm text-muted-foreground cursor-pointer select-none"
            >
              Show pipeline orders
            </Label>
            <Switch
              id="weekly-pipeline-toggle"
              checked={showPipelineWeekly}
              onCheckedChange={setShowPipelineWeekly}
            />
          </div>

          {weeklyLoading ? (
            <WeeklyBudgetSkeleton />
          ) : weeklyData ? (
            <WeeklyBudgetView
              data={weeklyData}
              showPipeline={showPipelineWeekly}
              onMoveBill={handleMoveBill}
            />
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p>No weekly budget data available.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Cash-flow timeline — month mode only */}
      {viewMode === 'month' && (cashFlow ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="h-4 w-4" />
                Cash-Flow Timeline
              </CardTitle>
              <div className="flex items-center gap-2">
                <Label
                  htmlFor="pipeline-toggle"
                  className="text-sm text-muted-foreground cursor-pointer select-none"
                >
                  Show pipeline orders
                </Label>
                <Switch
                  id="pipeline-toggle"
                  checked={showPipeline}
                  onCheckedChange={setShowPipeline}
                />
              </div>
            </div>
            {summary?.latestSnapshot && (
              <div className="text-xs text-muted-foreground">
                Opening balance: {formatMoney(cashFlow.openingBalance)} as of{' '}
                {format(parseISO(cashFlow.snapshotDate), 'MMM d, yyyy')}
                {showPipeline && (
                  <span className="ml-2 text-green-600/70">(including pipeline orders)</span>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {cashFlow.events.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                No cash-flow events for this period
              </div>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="hidden sm:table-cell w-[90px]">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="hidden sm:table-cell">Vendor</TableHead>
                      <TableHead className="text-right w-[130px]">Amount</TableHead>
                      <TableHead className="text-right w-[140px]">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Opening balance row */}
                    <TableRow className="bg-muted/30">
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                        {format(parseISO(cashFlow.snapshotDate), 'MMM d')}
                      </TableCell>
                      <TableCell className="text-sm font-medium text-muted-foreground">
                        Opening balance (snapshot)
                        <div className="sm:hidden text-xs text-muted-foreground mt-0.5">
                          {format(parseISO(cashFlow.snapshotDate), 'MMM d')}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell" />
                      <TableCell />
                      <TableCell className="text-right text-sm font-mono font-semibold">
                        {formatMoney(cashFlow.openingBalance)}
                      </TableCell>
                    </TableRow>

                    {cashFlow.events.map((event) => (
                      <CashFlowEventRow
                        key={`${event.kind}-${event.id}`}
                        event={event}
                        isTrough={troughId === event.id}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Trough summary footer */}
            {cashFlow.troughBalance < cashFlow.openingBalance && (
              <div
                className={`px-4 py-3 border-t text-sm flex items-center gap-2 ${
                  cashFlow.troughBalance < 0
                    ? 'bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400'
                    : 'bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400'
                }`}
              >
                {cashFlow.troughBalance < 0 ? (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Cash will go negative by {formatMoney(cashFlow.cashGap)}
                    {cashFlow.troughDate &&
                      ` on ${format(parseISO(cashFlow.troughDate), 'MMM d')}`}
                    {showPipeline
                      ? ' — even with pipeline revenue.'
                      : '. Add pipeline revenue with the toggle above.'}
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Lowest point: {formatMoney(cashFlow.troughBalance)}
                    {cashFlow.troughDate &&
                      ` on ${format(parseISO(cashFlow.troughDate), 'MMM d')}`}
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : summary && !summary.latestSnapshot ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>Record a cash-on-hand snapshot above to enable cash-flow projections.</p>
          </CardContent>
        </Card>
      ) : null)}

      {/* Untracked expenses (collapsed by default) — always visible */}
      <UntrackedExpensesPanel
        month={month}
        onCreateBill={handleCreateBillFromTransaction}
      />
    </div>
  )
}
