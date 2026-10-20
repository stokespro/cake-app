'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { addDays, format } from 'date-fns'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import {
  approveTrimPayout,
  getBatchPayoutReview,
  reverseTrimPayout,
  type ApprovePayoutResult,
  type BatchPayoutReview,
  type PayoutReviewTrimmer,
} from '@/actions/trim-pay'
import { BatchBanner } from './batch-banner'
import { dateOnlyText, lbText, moneyText, whenText } from './format'
import { HangerDetailSheet } from './hanger-detail-panel'
import { NoAccess } from './no-access'
import { ReasonDialog } from './reason-dialog'
import { Stat } from './stat'
import { TrimmerPayCard, type RowError } from './trimmer-pay-card'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'

const REVERSE_REASON_CHIPS = ['Wrong due date', 'Weights corrected', 'Approved by mistake', 'Other'] as const

const ALREADY_PAID = 'Already paid, cannot reverse. Finance has recorded a payment on this bill.'

/**
 * Review and approve a closed batch's pay, one trimmer at a time (R2.14). Approving raises a finance bill
 * through the database function; nothing here touches finance directly. Every figure is the server's: the
 * client sends only which trimmer and the due date.
 */
export function PayReviewClient({ batchId }: { batchId: string }) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [review, setReview] = useState<BatchPayoutReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dueDates, setDueDates] = useState<Record<string, string>>({})
  const [approvals, setApprovals] = useState<Record<string, ApprovePayoutResult>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({})
  const [confirming, setConfirming] = useState<PayoutReviewTrimmer | null>(null)
  const [reversing, setReversing] = useState<PayoutReviewTrimmer | null>(null)
  const [detailCode, setDetailCode] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await run(getBatchPayoutReview(batchId), { quiet: true })
    if (res.success) {
      setReview(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [batchId, run])

  useEffect(() => {
    void load()
  }, [load])
  useRefetchOnFocus(() => void load())

  function setRowError(trimmerId: string, err: RowError | null) {
    setRowErrors((prev) => {
      const next = { ...prev }
      if (err) next[trimmerId] = err
      else delete next[trimmerId]
      return next
    })
  }

  if (!access.ready) return <p className="py-12 text-center text-muted-foreground">Loading...</p>
  if (!access.canApprovePay) {
    return (
      <NoAccess
        title="Pay is not available to your role"
        message="Reviewing and approving trimmer pay is for the trim manager and admins."
        backHref={`${BASE}/batches/${batchId}`}
        backLabel="Back to the batch"
      />
    )
  }
  if (error && !review) {
    return (
      <div className="space-y-4">
        <BackLink batchId={batchId} />
        <ErrorState title="Could not load this batch's pay" message={error} onRetry={() => void load()} />
      </div>
    )
  }
  if (!review) return <p className="py-12 text-center text-muted-foreground">Loading...</p>

  const { close, totals, trimmers } = review
  const flaggedTrimmers = trimmers.filter((t) => t.flaggedEpisodes > 0)
  const minDate = close.closedAt ? format(new Date(close.closedAt), 'yyyy-MM-dd') : undefined
  const maxDate = format(addDays(new Date(), 365), 'yyyy-MM-dd')

  async function approve(t: PayoutReviewTrimmer) {
    const dueDate = dueDates[t.trimmerId]
    if (!dueDate) return
    const res = await run(approveTrimPayout({ batchId, trimmerId: t.trimmerId, dueDate }), { quiet: true })
    if (res.success) {
      setApprovals((prev) => ({ ...prev, [t.trimmerId]: res.data }))
      setRowError(t.trimmerId, null)
      toast.success(`Approved ${t.trimmerName}.`)
    } else {
      setRowError(t.trimmerId, { message: res.error, code: res.code })
    }
    // Success or not, the screen should show what the database now says.
    await load()
  }

  async function reverse(t: PayoutReviewTrimmer, reason: string): Promise<boolean> {
    const payoutId = t.payout?.payoutId
    if (!payoutId) return true
    const res = await run(reverseTrimPayout({ payoutId, reason }), { quiet: true })
    if (res.success) {
      setApprovals((prev) => {
        const next = { ...prev }
        delete next[t.trimmerId]
        return next
      })
      setRowError(t.trimmerId, null)
      toast.success(`Reversed ${t.trimmerName}. The bill is void.`)
      await load()
      return true
    }
    if (res.code === 'HAS_PAYMENTS') {
      setRowError(t.trimmerId, { message: ALREADY_PAID, code: res.code })
      await load()
      return true
    }
    toast.error(res.error)
    return false
  }

  return (
    <div className="space-y-5">
      <BackLink batchId={batchId} />
      <BatchBanner
        batch={{
          id: review.batchId,
          name: review.batchName,
          harvestDate: null,
          strainId: null,
          strainName: review.strainName,
          cycleId: null,
          cycleNumber: null,
          cycleStatus: null,
          cycleStage: null,
          roomName: null,
          roomNumber: null,
        }}
      />

      {close.closed ? (
        <p className="text-sm text-muted-foreground">
          Closed {whenText(close.closedAt)}
          {close.closedByName ? ` by ${close.closedByName}` : ''}.
        </p>
      ) : (
        <div role="alert" className="flex items-start gap-3 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">
              This batch is not closed, so pay cannot be approved.{' '}
              <Link href={`${BASE}/batches/${batchId}`} className="underline underline-offset-2">
                Go to the batch
              </Link>
            </p>
            {close.unfinishedLoads.length > 0 && (
              <p>
                Not finished:{' '}
                {close.unfinishedLoads.map((b, i) => (
                  <span key={`${b.hangerCode}-${b.status}`}>
                    {i > 0 && ', '}
                    <Link
                      href={`${BASE}/station?code=${encodeURIComponent(b.hangerCode)}`}
                      className="font-mono font-semibold underline underline-offset-2"
                    >
                      {b.hangerCode}
                    </Link>{' '}
                    ({b.status === 'checked_out' ? 'checked out' : b.status})
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
      )}

      {totals.flaggedEpisodes > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border-2 border-red-500/60 bg-red-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <p className="text-sm font-medium">
            {totals.flaggedEpisodes} flagged {totals.flaggedEpisodes === 1 ? 'return is' : 'returns are'} still
            unresolved ({flaggedTrimmers.map((t) => t.trimmerName).join(', ')}). Nothing is owed on{' '}
            {totals.flaggedEpisodes === 1 ? 'it' : 'them'} until decided, so these totals are not final.
          </p>
        </div>
      )}

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Trimmers">{totals.trimmers}</Stat>
        <Stat label="Flower">{lbText(totals.flowerG)}</Stat>
        <Stat label="Owed" sub={totals.flaggedEpisodes > 0 ? 'excludes flagged returns' : undefined}>
          {moneyText(totals.amountOwed)}
        </Stat>
        <Stat label="Approved" sub={`${totals.approvedTrimmers} of ${totals.trimmers} trimmers`}>
          {moneyText(totals.approvedAmount)}
        </Stat>
      </section>

      <section aria-label="Trimmers" className="space-y-3">
        <h2 className="text-lg font-semibold">
          By trimmer <span className="text-base font-normal text-muted-foreground">({trimmers.length})</span>
        </h2>
        {trimmers.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-muted-foreground">
              No trimmer has returned a hanger from this batch.
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-3">
            {trimmers.map((t) => (
              <TrimmerPayCard
                key={t.trimmerId}
                t={t}
                batchId={batchId}
                closed={close.closed}
                dueDate={dueDates[t.trimmerId] ?? ''}
                minDate={minDate}
                maxDate={maxDate}
                onDueDate={(d) => setDueDates((prev) => ({ ...prev, [t.trimmerId]: d }))}
                onApprove={() => setConfirming(t)}
                onReverse={() => setReversing(t)}
                onOpenHanger={setDetailCode}
                approval={approvals[t.trimmerId]}
                error={rowErrors[t.trimmerId]}
                canOpenBills={access.isFinance}
              />
            ))}
          </ul>
        )}
      </section>

      <ApproveDialog
        trimmer={confirming}
        dueDate={confirming ? (dueDates[confirming.trimmerId] ?? '') : ''}
        onOpenChange={(o) => !o && setConfirming(null)}
        onConfirm={async (t) => {
          await approve(t)
          setConfirming(null)
        }}
      />

      <ReasonDialog
        open={reversing !== null}
        onOpenChange={(o) => !o && setReversing(null)}
        title={reversing ? `Reverse ${reversing.trimmerName}'s payout?` : 'Reverse payout?'}
        description={
          reversing?.payout
            ? `This voids the ${moneyText(reversing.payout.amount)} bill due ${dateOnlyText(reversing.payout.dueDate)}. The pay goes back to ready and can be approved again.`
            : undefined
        }
        chips={REVERSE_REASON_CHIPS}
        confirmLabel="Reverse and void bill"
        destructive
        onConfirm={(reason) => (reversing ? reverse(reversing, reason) : Promise.resolve(true))}
      />

      <HangerDetailSheet code={detailCode} onOpenChange={(o) => !o && setDetailCode(null)} />
    </div>
  )
}

function ApproveDialog({
  trimmer,
  dueDate,
  onOpenChange,
  onConfirm,
}: {
  trimmer: PayoutReviewTrimmer | null
  dueDate: string
  onOpenChange: (open: boolean) => void
  onConfirm: (t: PayoutReviewTrimmer) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    if (!trimmer || busy) return
    setBusy(true)
    await onConfirm(trimmer)
    setBusy(false)
  }

  return (
    <Dialog open={trimmer !== null} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{trimmer ? `Approve ${trimmer.trimmerName}?` : 'Approve?'}</DialogTitle>
          {trimmer && (
            <DialogDescription>
              Raises a {moneyText(trimmer.amountOwed)} bill to {trimmer.vendorName ?? 'their vendor'}, due{' '}
              {dateOnlyText(dueDate)}.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" className="font-semibold" onClick={confirm} disabled={busy}>
            {busy ? 'Approving...' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackLink({ batchId }: { batchId: string }) {
  return (
    <Button asChild variant="ghost" className="-ml-3">
      <Link href={`${BASE}/batches/${batchId}`}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Batch
      </Link>
    </Button>
  )
}
