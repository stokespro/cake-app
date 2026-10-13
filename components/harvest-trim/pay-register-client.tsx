'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { addDays, format } from 'date-fns'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getPayRegister, type PayRegister, type PayRegisterRow, type PayRegisterStatus } from '@/actions/trim-pay'
import { billStatusMeta, dateOnlyText, lbText, moneyText, whenText } from './format'
import { NoAccess } from './no-access'
import { Stat } from './stat'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'
const DASH = '—'

const STATUS_OPTIONS: Array<{ value: 'all' | PayRegisterStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partial', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'reversed', label: 'Reversed' },
]

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold', className)}>
      {children}
    </span>
  )
}

function RowStatus({ r }: { r: PayRegisterRow }) {
  if (r.payoutStatus === 'reversed') {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <Pill className="border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300">Reversed</Pill>
        {r.reversedAt && <span className="text-xs text-muted-foreground">{whenText(r.reversedAt)}</span>}
      </span>
    )
  }
  const b = billStatusMeta(r.billStatus)
  return <Pill className={b.pill}>{b.label}</Pill>
}

function BatchLink({ r }: { r: PayRegisterRow }) {
  return (
    <Link href={`${BASE}/batches/${r.batchId}/pay`} className="underline-offset-2 hover:underline">
      {r.batchName ?? DASH}
    </Link>
  )
}

function TrimmerLink({ r }: { r: PayRegisterRow }) {
  return (
    <Link href={`${BASE}/staff/${r.trimmerId}`} className="font-semibold underline-offset-2 hover:underline">
      {r.trimmerName ?? DASH}
    </Link>
  )
}

/**
 * Trimmer payouts with the finance bill behind each, for payroll. Finance only. Payment state is read
 * from the bill; this screen records nothing.
 */
export function PayRegisterClient() {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [from, setFrom] = useState(() => format(addDays(new Date(), -30), 'yyyy-MM-dd'))
  const [to, setTo] = useState(() => format(addDays(new Date(), 60), 'yyyy-MM-dd'))
  const [status, setStatus] = useState<'all' | PayRegisterStatus>('all')
  const [register, setRegister] = useState<PayRegister | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!from || !to) return
    const mine = ++seq.current
    setLoading(true)
    const res = await run(getPayRegister({ from, to, status: status === 'all' ? undefined : status }), { quiet: true })
    if (mine !== seq.current) return
    if (res.success) {
      setRegister(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoading(false)
  }, [from, to, status, run])

  const allowed = access.ready && access.isFinance
  useEffect(() => {
    if (allowed) void load()
  }, [allowed, load])
  useRefetchOnFocus(() => {
    if (allowed) void load()
  })

  if (!access.ready) return <p className="py-12 text-center text-muted-foreground">Loading...</p>
  if (!access.isFinance) {
    return (
      <NoAccess
        title="The pay register is for finance"
        message="Trimmer pay is approved on each batch. Payments are recorded in finance."
        backHref={BASE}
        backLabel="Back to Harvest & Trim"
      />
    )
  }

  const rows = register?.rows ?? []
  const reversed = rows.filter((r) => r.payoutStatus === 'reversed').length

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Pay register</h2>
        <p className="text-sm text-muted-foreground">Trimmer payouts by due date, with their bills</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="register-from">Due from</Label>
          <Input id="register-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="register-to">Due to</Label>
          <Input id="register-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="col-span-2 space-y-1 md:col-span-1">
          <Label htmlFor="register-status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as 'all' | PayRegisterStatus)}>
            <SelectTrigger id="register-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <ErrorState title="Could not load the register" message={error} onRetry={() => void load()} />
      )}

      {!register && !error && <p className="py-8 text-center text-muted-foreground">Loading...</p>}

      {register && (
        <div className={cn('space-y-4', (loading || error) && 'opacity-60')}>
          {register.truncated && (
            <div role="alert" className="flex items-start gap-3 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <p className="text-sm font-medium">
                More payouts match than can be listed, so the rows and totals are incomplete. Narrow the date range.
              </p>
            </div>
          )}

          <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Payouts">{register.totals.payouts}</Stat>
            <Stat label="Approved">{moneyText(register.totals.approvedAmount)}</Stat>
            <Stat label="Paid">{moneyText(register.totals.amountPaid)}</Stat>
            <Stat label="Outstanding">{moneyText(register.totals.outstanding)}</Stat>
          </section>
          {reversed > 0 && (
            <p className="text-sm text-muted-foreground">
              {reversed} reversed {reversed === 1 ? 'payout is' : 'payouts are'} listed but left out of the totals.
            </p>
          )}

          {rows.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-center text-muted-foreground">
                No payouts are due in this range.
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Wide screens */}
              <div className="hidden rounded-lg border bg-card lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trimmer</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead className="text-right">Flower</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Bill</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Approved</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const isReversed = r.payoutStatus === 'reversed'
                      return (
                        <TableRow key={r.payoutId} className={cn(isReversed && 'bg-muted/40 text-muted-foreground')}>
                          <TableCell className="align-top">
                            <TrimmerLink r={r} />
                            <p className="text-xs text-muted-foreground">{r.vendorName ?? DASH}</p>
                          </TableCell>
                          <TableCell className="align-top">
                            <BatchLink r={r} />
                          </TableCell>
                          <TableCell className="text-right align-top">{lbText(r.flowerG)}</TableCell>
                          <TableCell className={cn('text-right align-top font-semibold', isReversed && 'line-through')}>
                            {moneyText(r.amount)}
                          </TableCell>
                          <TableCell className="align-top">{dateOnlyText(r.dueDate)}</TableCell>
                          <TableCell className="align-top">
                            <RowStatus r={r} />
                            {isReversed && r.reverseReason && (
                              <p className="mt-1 max-w-48 text-xs">{r.reverseReason}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top">
                            {isReversed ? DASH : moneyText(r.amountPaid ?? 0)}
                            {!isReversed && r.paidDate && (
                              <p className="text-xs text-muted-foreground">{dateOnlyText(r.paidDate)}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top font-semibold">
                            {isReversed ? DASH : moneyText(r.balance)}
                          </TableCell>
                          <TableCell className="align-top">
                            {r.approvedByName ?? DASH}
                            <p className="text-xs text-muted-foreground">{whenText(r.approvedAt)}</p>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Phones and tablets */}
              <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
                {rows.map((r) => {
                  const isReversed = r.payoutStatus === 'reversed'
                  return (
                    <li
                      key={r.payoutId}
                      className={cn('space-y-2 rounded-lg border p-3', isReversed ? 'border-dashed bg-muted/40' : 'bg-card')}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-lg leading-tight">
                            <TrimmerLink r={r} />
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {r.vendorName ?? DASH} &middot; <BatchLink r={r} />
                          </p>
                        </div>
                        <RowStatus r={r} />
                      </div>
                      {isReversed && r.reverseReason && (
                        <p className="text-sm text-muted-foreground">Reversed: {r.reverseReason}</p>
                      )}
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <div>
                          <dt className="text-xs text-muted-foreground">Amount</dt>
                          <dd className={cn('font-semibold', isReversed && 'line-through')}>{moneyText(r.amount)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Flower</dt>
                          <dd>{lbText(r.flowerG)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Due</dt>
                          <dd>{dateOnlyText(r.dueDate)}</dd>
                        </div>
                        {!isReversed && (
                          <>
                            <div>
                              <dt className="text-xs text-muted-foreground">Paid</dt>
                              <dd>
                                {moneyText(r.amountPaid ?? 0)}
                                {r.paidDate && (
                                  <span className="block text-xs text-muted-foreground">{dateOnlyText(r.paidDate)}</span>
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">Balance</dt>
                              <dd className="font-semibold">{moneyText(r.balance)}</dd>
                            </div>
                          </>
                        )}
                        <div className="col-span-2">
                          <dt className="text-xs text-muted-foreground">Approved</dt>
                          <dd>
                            {r.approvedByName ?? DASH} &middot; {whenText(r.approvedAt)}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
