'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getTrimStaff,
  setTrimStaffActive,
  updateTrimStaffRate,
  type TrimStaffDetail,
} from '@/actions/trim-staff'
import { getTrimBoard, type BoardOut } from '@/actions/harvest-trim'
import { agoText, dateOnlyText, lbText, trimmerName, whenText } from './format'
import { StaffForm } from './staff-form'
import { TrimmerPerformance } from './trimmer-performance'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'
const RATE_KEYSTROKE = /^\d{0,4}\.?\d{0,2}$/

export function StaffDetailClient({ id }: { id: string }) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [staff, setStaff] = useState<TrimStaffDetail | null>(null)
  const [holding, setHolding] = useState<BoardOut[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [changingRate, setChangingRate] = useState(false)
  const [newRate, setNewRate] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [res, board] = await Promise.all([run(getTrimStaff(id), { quiet: true }), run(getTrimBoard(), { quiet: true })])
    if (res.success) {
      setStaff(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
    if (board.success) setHolding(board.data.out.filter((o) => o.trimmerId === id))
  }, [id, run])

  useEffect(() => {
    void load()
  }, [load])
  useRefetchOnFocus(() => void load())

  if (error && !staff) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState title="Could not load this trimmer" message={error} onRetry={() => void load()} />
      </div>
    )
  }
  if (!staff) return <p className="py-12 text-center text-muted-foreground">Loading...</p>

  const showPay = access.canSeePay && staff.payPerLb !== null
  const rateNum = newRate === '' ? null : Number(newRate)
  const rateValid = rateNum !== null && Number.isFinite(rateNum) && rateNum >= 0 && rateNum <= 1000

  async function toggleActive() {
    if (!staff) return
    setBusy(true)
    const res = await run(setTrimStaffActive(staff.id, !staff.isActive))
    setBusy(false)
    if (res.success) {
      toast.success(staff.isActive ? 'Marked inactive' : 'Back to active')
      void load()
    }
  }

  async function saveRate() {
    if (!staff || !rateValid || rateNum === null) return
    setBusy(true)
    const res = await run(updateTrimStaffRate(staff.id, rateNum))
    setBusy(false)
    if (res.success) {
      toast.success('Rate updated')
      setChangingRate(false)
      setNewRate('')
      void load()
    }
  }

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{trimmerName(staff)}</h2>
          {staff.displayName && <p className="text-muted-foreground">{staff.fullName}</p>}
          <p className="mt-1 text-sm font-semibold">{staff.isActive ? 'Active' : 'Inactive'}</p>
        </div>
        {access.canOperate && (
          <Button type="button" variant="outline" disabled={busy} onClick={toggleActive}>
            {staff.isActive ? 'Mark inactive' : 'Make active again'}
          </Button>
        )}
      </div>

      {/* Details */}
      <Card>
        <CardContent className="space-y-3 pt-5">
          {editing ? (
            <StaffForm
              staff={staff}
              onSaved={() => {
                setEditing(false)
                toast.success('Saved')
                void load()
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">Details</h3>
                {access.canManageStaff && (
                  <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                )}
              </div>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Field label="Phone" value={staff.phone} />
                <Field label="Email" value={staff.email} />
                <Field label="Start date" value={staff.startDate ? dateOnlyText(staff.startDate) : null} />
                {access.canManageStaff && (
                  <Field
                    label="Paid through"
                    value={staff.vendorName}
                    empty="No vendor yet. Pay cannot be approved until one is set."
                  />
                )}
                <Field label="Notes" value={staff.notes} />
              </dl>
            </>
          )}
        </CardContent>
      </Card>

      {/* Pay rate and its history */}
      {showPay && (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Pay rate</h3>
                <p className="text-2xl font-bold">
                  ${staff.payPerLb?.toFixed(2)} <span className="text-base font-normal text-muted-foreground">per lb of flower</span>
                </p>
              </div>
              {access.canManageStaff && !changingRate && (
                <Button type="button" variant="outline" onClick={() => setChangingRate(true)}>
                  Change rate
                </Button>
              )}
            </div>

            {changingRate && (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="new-rate">
                    New rate
                  </Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base text-muted-foreground">$</span>
                    <Input
                      id="new-rate"
                      type="text"
                      inputMode="decimal"
                      autoFocus
                      value={newRate}
                      onChange={(e) => RATE_KEYSTROKE.test(e.target.value) && setNewRate(e.target.value)}
                      placeholder={staff.payPerLb?.toFixed(2)}
                      className="h-12 pl-9 pr-16 text-lg font-semibold md:text-xl"
                    />
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground">/ lb</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Applies to hangers issued from now on. Hangers already out keep the rate they were issued at. The
                    change is logged.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button type="button" className="h-12 text-base font-semibold" disabled={!rateValid || busy} onClick={saveRate}>
                    {busy ? 'Saving...' : 'Save new rate'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                   
                    disabled={busy}
                    onClick={() => {
                      setChangingRate(false)
                      setNewRate('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-semibold">Rate history</p>
              {staff.rateHistory && staff.rateHistory.length > 0 ? (
                <ul className="space-y-1.5">
                  {staff.rateHistory.map((r, i) => (
                    <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <span className="font-semibold">
                        {r.oldRate !== null ? `$${r.oldRate.toFixed(2)}` : '—'} {'→'}{' '}
                        {r.newRate !== null ? `$${r.newRate.toFixed(2)}` : '—'}
                      </span>
                      <span className="text-muted-foreground">{whenText(r.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">The rate has not changed since this trimmer was added.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Holding right now */}
      <section aria-label="Holding now" className="space-y-3">
        <h3 className="text-lg font-semibold">Holding right now</h3>
        {holding.length === 0 ? (
          <Card>
            <CardContent className="py-5 text-center text-muted-foreground">No hangers out with {trimmerName(staff)}.</CardContent>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            {holding.map((o) => (
              <Link
                key={o.checkoutId}
                href={`${access.canOperate ? `${BASE}/station` : `${BASE}/lookup`}?code=${encodeURIComponent(o.hangerCode)}`}
                className="flex min-h-12 flex-col justify-center rounded-lg border-2 border-amber-500/50 bg-amber-500/10 px-3 py-1"
              >
                <span className="font-mono text-base font-bold leading-tight">{o.hangerCode}</span>
                <span className="text-xs text-muted-foreground">
                  {lbText(o.issuedG)} &middot; {agoText(o.checkedOutAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <TrimmerPerformance trimmerId={staff.id} />
    </div>
  )
}

function BackLink() {
  return (
    <Button asChild variant="ghost" className="-ml-3">
      <Link href={`${BASE}/staff`}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        All trimmers
      </Link>
    </Button>
  )
}

function Field({ label, value, empty = '—' }: { label: string; value: string | null; empty?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value || <span className="text-muted-foreground">{empty}</span>}</dd>
    </div>
  )
}
