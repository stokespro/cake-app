'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ApprovePayoutResult, PayoutReviewTrimmer } from '@/actions/trim-pay'
import type { ActionErrorCode } from '@/types/harvest-trim'
import { billStatusMeta, dateOnlyText, moneyText, rateRangeText, ratesText, whenText } from './format'
import { Mass } from './mass'

const BASE = '/dashboard/harvest-trim'

export interface RowError {
  message: string
  code?: ActionErrorCode
}

interface TrimmerPayCardProps {
  t: PayoutReviewTrimmer
  batchId: string
  closed: boolean
  dueDate: string
  /** Earliest / latest due date offered. The database enforces the real limits. */
  minDate?: string
  maxDate?: string
  onDueDate: (date: string) => void
  onApprove: () => void
  onReverse: () => void
  onOpenHanger: (code: string) => void
  /** Present in the session that approved this trimmer: the bill that was raised. */
  approval?: ApprovePayoutResult
  error?: RowError
  /** Finance can open the bills page; others are only told it exists. */
  canOpenBills: boolean
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', className)}>{children}</span>
}

/** Why a trimmer cannot be approved, in a sentence. Null when they can (or when it is the vendor, shown separately). */
export function approveBlocker(t: PayoutReviewTrimmer, closed: boolean): string | null {
  if (t.flaggedEpisodes > 0) {
    const n = t.flaggedEpisodes
    return `${n} flagged ${n === 1 ? 'return is' : 'returns are'} unresolved. Nothing is owed on ${n === 1 ? 'it' : 'them'} until decided.`
  }
  if (!closed) return 'Close the batch before approving pay.'
  if (t.vendorId === null || t.vendorActive === false) return null
  if (t.readyEntries === 0 || t.amountOwed <= 0) return 'Nothing is ready to approve.'
  return null
}

function VendorNeeded({ t }: { t: PayoutReviewTrimmer }) {
  const inactive = t.vendorId !== null && t.vendorActive === false
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-amber-500/50 bg-amber-500/10 p-3">
      <p className="text-sm font-medium">
        {inactive
          ? `${t.vendorName ?? 'Their vendor'} is inactive, so there is no one to bill.`
          : `${t.trimmerName} has no vendor linked, so there is no one to bill.`}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href={`${BASE}/staff/${t.trimmerId}`}>{inactive ? 'Change vendor' : 'Link a vendor'}</Link>
      </Button>
    </div>
  )
}

export function TrimmerPayCard({
  t,
  batchId,
  closed,
  dueDate,
  minDate,
  maxDate,
  onDueDate,
  onApprove,
  onReverse,
  onOpenHanger,
  approval,
  error,
  canOpenBills,
}: TrimmerPayCardProps) {
  const payout = t.payout
  const blocker = payout ? null : approveBlocker(t, closed)
  const needsVendor = !payout && !blocker && (t.vendorId === null || t.vendorActive === false)
  const canApproveNow = !payout && !blocker && !needsVendor && t.canApprove
  const bill = payout ? billStatusMeta(payout.billStatus) : null
  const hasPayment = (payout?.amountPaid ?? 0) > 0
  const multipleRates = t.ratesPerLb.length > 1

  return (
    <li
      className={cn(
        'space-y-3 rounded-lg border p-3 md:p-4',
        t.flaggedEpisodes > 0 ? 'border-red-500/60 bg-red-500/5' : 'bg-card'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-lg font-semibold">{t.trimmerName}</p>
        <div className="flex flex-wrap gap-2">
          {t.flaggedEpisodes > 0 && (
            <Pill className="border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300">
              {t.flaggedEpisodes} flagged, no pay yet
            </Pill>
          )}
          {payout && (
            <Pill className="border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300">Approved</Pill>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-5">
        <div>
          <dt className="text-xs text-muted-foreground">Hangers</dt>
          <dd className="font-semibold">{t.hangers}</dd>
          <dd className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
            {t.hangerCodes.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => onOpenHanger(code)}
                className="font-mono underline-offset-2 hover:underline"
              >
                {code}
              </button>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Returns</dt>
          <dd className="font-semibold">{t.episodes}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Flower</dt>
          <dd>
            <Mass g={t.flowerG} stacked />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Rate</dt>
          <dd className="font-semibold">{ratesText(t.ratesPerLb)}</dd>
          {multipleRates && <dd className="text-xs text-muted-foreground">changed during the batch</dd>}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Owed</dt>
          <dd className="font-semibold">{moneyText(t.amountOwed)}</dd>
          <dd className="text-xs text-muted-foreground">{t.vendorName ? `Bill to ${t.vendorName}` : 'No vendor'}</dd>
        </div>
      </dl>

      <div className="space-y-3 border-t pt-3">
        {payout && bill && (
          <>
            {approval && (
              <div role="status" className="space-y-2">
                <p className="text-sm">
                  Bill raised: <strong>{approval.billName ?? 'Trim payout'}</strong>, {moneyText(approval.amount)}, due{' '}
                  {dateOnlyText(approval.dueDate)}, unpaid. Finance pays it from the{' '}
                  {canOpenBills ? (
                    <Link href="/dashboard/finance/bills" className="underline underline-offset-2">
                      bills page
                    </Link>
                  ) : (
                    'bills page'
                  )}
                  .
                </p>
                {approval.rateChanged && (
                  <div className="flex items-start gap-3 rounded-lg border-2 border-amber-500 bg-amber-500/10 p-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                    <p className="text-sm font-medium">
                      Rate changed from {rateRangeText(approval.previousRateMin, approval.previousRateMax)} on their last
                      payout to {rateRangeText(approval.rateMin, approval.rateMax)}. It is noted on the bill.
                    </p>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span>
                  {moneyText(payout.amount)} due {dateOnlyText(payout.dueDate)}
                </span>
                <Pill className={bill.pill}>{bill.label}</Pill>
                {hasPayment && <span>{moneyText(payout.amountPaid)} paid</span>}
                <span className="text-muted-foreground">approved {whenText(payout.approvedAt)}</span>
              </p>
              {hasPayment ? (
                <p className="text-sm text-muted-foreground">Already paid, cannot reverse.</p>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={onReverse}>
                  Reverse
                </Button>
              )}
            </div>
          </>
        )}

        {blocker && (
          <p className={cn('text-sm', t.flaggedEpisodes > 0 ? 'font-medium text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
            {blocker}{' '}
            {t.flaggedEpisodes > 0 && (
              <Link href={`${BASE}/batches/${batchId}`} className="underline underline-offset-2">
                Open the batch
              </Link>
            )}
          </p>
        )}

        {needsVendor && <VendorNeeded t={t} />}

        {canApproveNow && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor={`due-${t.trimmerId}`}>Due date</Label>
              <Input
                id={`due-${t.trimmerId}`}
                type="date"
                className="w-44"
                value={dueDate}
                min={minDate}
                max={maxDate}
                onChange={(e) => onDueDate(e.target.value)}
              />
            </div>
            <Button type="button" disabled={!dueDate} onClick={onApprove}>
              Approve {moneyText(t.amountOwed)}
            </Button>
          </div>
        )}

        {error &&
          (error.code === 'NO_VENDOR' ? (
            // Already shown above when the refetch confirmed it; otherwise the server knows better.
            !needsVendor && <VendorNeeded t={{ ...t, vendorId: null, vendorActive: null }} />
          ) : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error.message}
            </p>
          ))}
      </div>
    </li>
  )
}
