'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  closeTrimBatch,
  getBatchPayoutReview,
  reopenTrimBatch,
  type BatchPayoutReview,
  type CloseBatchResult,
} from '@/actions/trim-pay'
import { moneyText, whenText } from './format'
import { ReasonDialog } from './reason-dialog'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'

export const REOPEN_REASON_CHIPS = ['Missed a hanger', 'Weight correction', 'Closed by mistake', 'Other'] as const

function stationHref(code: string): string {
  return `${BASE}/station?code=${encodeURIComponent(code)}`
}

/** "H1B-003 (partial)" as the server writes it, so the codes in an error message can be tapped. */
const BLOCKER_TOKEN = /([A-Za-z0-9][A-Za-z0-9-]*) \((hung|dried|checked_out|partial|flagged)\)/g

/** The server's message verbatim, with every named hanger turned into a link to the station. */
function BlockerMessage({ message }: { message: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of message.matchAll(BLOCKER_TOKEN)) {
    const at = m.index ?? 0
    if (at > last) parts.push(message.slice(last, at))
    parts.push(
      <Link key={`${at}-${m[1]}`} href={stationHref(m[1])} className="font-mono font-semibold underline underline-offset-2">
        {m[0]}
      </Link>
    )
    last = at + m[0].length
  }
  if (last < message.length) parts.push(message.slice(last))
  return <>{parts}</>
}

interface BatchCloseCardProps {
  batchId: string
  /** Called after a close or reopen so the page around the card refetches. */
  onChanged: () => void
}

/**
 * Close (and, for admins, reopen) a batch. Closing locks the hangers and readies the pay lines; it does
 * not make the batch sellable and it does not move money. The blockers come from the pay review so they
 * can be shown before anyone tries; the close itself re-checks everything under a lock, and whatever it
 * says is shown as it is written.
 */
export function BatchCloseCard({ batchId, onChanged }: BatchCloseCardProps) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [review, setReview] = useState<BatchPayoutReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [justClosed, setJustClosed] = useState<CloseBatchResult | null>(null)

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

  if (!access.canOperate) return null
  if (error && !review) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p className="text-destructive">{error}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (!review) return null

  const { close, totals } = review
  const blockers = close.unfinishedLoads
  const nothingFinished = close.reconciledLoads === 0
  const approved = totals.approvedTrimmers

  async function afterChange() {
    await load()
    onChanged()
  }

  return (
    <section aria-label="Close batch">
      <Card>
        <CardContent className="space-y-4 pt-5">
          {close.closed ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Batch closed</h2>
                  <p className="text-sm text-muted-foreground">
                    {whenText(close.closedAt)}
                    {close.closedByName ? ` by ${close.closedByName}` : ''}
                  </p>
                </div>
                <Button asChild>
                  <Link href={`${BASE}/batches/${batchId}/pay`}>Review pay</Link>
                </Button>
              </div>

              {justClosed && (
                <div
                  role="status"
                  className="flex items-start gap-3 rounded-lg border-2 border-green-500/50 bg-green-500/10 p-3"
                >
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
                  <div className="space-y-1 text-sm">
                    <p className="font-semibold">
                      {justClosed.hangers} {justClosed.hangers === 1 ? 'hanger' : 'hangers'} locked.{' '}
                      {moneyText(justClosed.totalAmount)} across {justClosed.trimmers.length}{' '}
                      {justClosed.trimmers.length === 1 ? 'trimmer' : 'trimmers'} is ready for approval.
                    </p>
                    <p>
                      <strong>Not sellable yet.</strong> The inventory manager makes the batch active in{' '}
                      <Link href="/dashboard/vault/admin" className="underline underline-offset-2">
                        vault admin
                      </Link>{' '}
                      once the COA is in.
                    </p>
                  </div>
                </div>
              )}

              {access.canReopenBatch && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-sm text-muted-foreground">
                    {approved > 0 ? 'Reverse the approved payouts before reopening.' : 'Admin only.'}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={approved > 0}
                    onClick={() => setReopenOpen(true)}
                  >
                    Reopen batch
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Close batch</h2>
                <Button
                  type="button"
                  disabled={blockers.length > 0 || nothingFinished}
                  onClick={() => setCloseOpen(true)}
                >
                  Close batch
                </Button>
              </div>
              {blockers.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {blockers.length} {blockers.length === 1 ? 'hanger is' : 'hangers are'} not finished:
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {blockers.map((b) => (
                      <li key={`${b.hangerCode}-${b.status}`}>
                        <Link
                          href={stationHref(b.hangerCode)}
                          className={cn(
                            'inline-flex min-h-10 items-center gap-1.5 rounded-lg border-2 px-3 py-1 text-sm',
                            b.status === 'flagged'
                              ? 'border-red-500/60 bg-red-500/10 font-semibold text-red-700 dark:text-red-300'
                              : 'border-border bg-card'
                          )}
                        >
                          <span className="font-mono font-bold">{b.hangerCode}</span>
                          <span>{b.status === 'checked_out' ? 'checked out' : b.status}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : nothingFinished ? (
                <p className="text-sm text-muted-foreground">No hanger in this batch has been finished yet.</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {close.reconciledLoads} finished {close.reconciledLoads === 1 ? 'hanger' : 'hangers'}
                  {close.voidLoads > 0 ? `, ${close.voidLoads} void` : ''}.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <CloseDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        batchId={batchId}
        onClosed={async (result) => {
          setJustClosed(result)
          await afterChange()
        }}
        onFailed={() => void load()}
      />

      <ReasonDialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        title="Reopen this batch?"
        description="Pay goes back to open and hangers can be worked again. Close the batch again when it is done."
        chips={REOPEN_REASON_CHIPS}
        confirmLabel="Reopen batch"
        destructive
        onConfirm={async (reason) => {
          const res = await run(reopenTrimBatch({ batchId, reason }))
          if (!res.success) return false
          toast.success('Batch reopened.')
          setJustClosed(null)
          await afterChange()
          return true
        }}
      />
    </section>
  )
}

interface CloseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  batchId: string
  onClosed: (result: CloseBatchResult) => Promise<void>
  onFailed: () => void
}

/** The rack check: the user types the count; it is never pre-filled, and the database compares it. */
function CloseDialog({ open, onOpenChange, batchId, onClosed, onFailed }: CloseDialogProps) {
  const run = useTrimRun()
  const [count, setCount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setCount('')
      setBusy(false)
      setError(null)
    }
  }, [open])

  const valid = /^\d{1,5}$/.test(count.trim())

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const res = await run(closeTrimBatch({ batchId, confirmedHangerCount: Number(count.trim()) }), { quiet: true })
    setBusy(false)
    if (res.success) {
      onOpenChange(false)
      await onClosed(res.data)
      return
    }
    // Keep the dialog open with the server's words: a mismatch is retried with a new count, and a
    // blocker list is the thing to act on.
    setError(
      res.code === 'RECONCILE'
        ? `Nothing was closed. The pay lines do not match what was trimmed. ${res.error}`
        : res.error
    )
    onFailed()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close this batch?</DialogTitle>
          <DialogDescription>Count the finished hangers on the rack and enter the number.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="close-hanger-count">Hangers on the rack</Label>
            <Input
              id="close-hanger-count"
              inputMode="numeric"
              autoComplete="off"
              value={count}
              onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 5))}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <BlockerMessage message={error} />
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" className="font-semibold" disabled={!valid || busy}>
              {busy ? 'Closing...' : 'Close batch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
