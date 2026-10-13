'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  createTrimStaff,
  updateTrimStaff,
  type TrimStaffRow,
} from '@/actions/trim-staff'
import { VendorPicker } from './vendor-picker'
import { useTrimRun } from './use-trim-run'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RATE_KEYSTROKE = /^\d{0,4}\.?\d{0,2}$/

interface StaffFormProps {
  /** Present when editing; absent when hiring. */
  staff?: TrimStaffRow
  /** Called with the trimmer id after a successful save. */
  onSaved: (id: string) => void
  onCancel?: () => void
}

function blankToNull(v: string): string | null {
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * Hire or edit a trimmer. The pay rate is entered here at hire time (the trim
 * manager hires and negotiates, R2.15); changing it later goes through the
 * audited "Change rate" action on the detail page, not this form.
 */
export function StaffForm({ staff, onSaved, onCancel }: StaffFormProps) {
  const run = useTrimRun()
  const editing = staff !== undefined
  const [fullName, setFullName] = useState(staff?.fullName ?? '')
  const [displayName, setDisplayName] = useState(staff?.displayName ?? '')
  const [phone, setPhone] = useState(staff?.phone ?? '')
  const [email, setEmail] = useState(staff?.email ?? '')
  const [startDate, setStartDate] = useState(staff?.startDate ?? '')
  const [rate, setRate] = useState('')
  const [vendorId, setVendorId] = useState<string | null>(staff?.vendorId ?? null)
  const [notes, setNotes] = useState(staff?.notes ?? '')
  const [busy, setBusy] = useState(false)

  const rateNum = rate === '' ? null : Number(rate)
  const rateValid = rateNum !== null && Number.isFinite(rateNum) && rateNum >= 0 && rateNum <= 1000
  const emailValid = email.trim() === '' || EMAIL_RE.test(email.trim())
  const canSave = fullName.trim() !== '' && emailValid && (editing || rateValid) && !busy

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    const common = {
      displayName: blankToNull(displayName),
      phone: blankToNull(phone),
      email: blankToNull(email),
      startDate: startDate === '' ? null : startDate,
      vendorId,
      notes: blankToNull(notes),
    }
    if (editing && staff) {
      const res = await run(updateTrimStaff(staff.id, { fullName: fullName.trim(), ...common }))
      setBusy(false)
      if (res.success) onSaved(staff.id)
    } else {
      const res = await run(createTrimStaff({ fullName: fullName.trim(), payPerLb: rateNum ?? 0, ...common }))
      setBusy(false)
      if (res.success) onSaved(res.data.id)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="staff-full-name" className="text-base font-semibold">
          Full name
        </Label>
        <Input
          id="staff-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          maxLength={120}
          autoComplete="off"
          className="h-14 text-base"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="staff-display-name" className="text-base font-semibold">
          Shown on buttons <span className="text-sm font-normal text-muted-foreground">(optional, e.g. a first name)</span>
        </Label>
        <Input
          id="staff-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={60}
          autoComplete="off"
          className="h-14 text-base"
        />
      </div>

      {!editing && (
        <div className="space-y-1.5">
          <Label htmlFor="staff-rate" className="text-base font-semibold">
            Pay per lb of flower
          </Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">$</span>
            <Input
              id="staff-rate"
              type="text"
              inputMode="decimal"
              value={rate}
              onChange={(e) => RATE_KEYSTROKE.test(e.target.value) && setRate(e.target.value)}
              placeholder="0.00"
              className="h-16 pl-9 pr-16 text-2xl font-semibold"
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground">/ lb</span>
          </div>
          <p className={rate !== '' && !rateValid ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}>
            {rate !== '' && !rateValid ? 'Enter a rate from 0 to 1000.' : 'Applies to hangers issued from now on.'}
          </p>
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="staff-phone" className="text-base font-semibold">
            Phone
          </Label>
          <Input
            id="staff-phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            className="h-14 text-base"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="staff-start" className="text-base font-semibold">
            Start date
          </Label>
          <Input
            id="staff-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-14 text-base"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="staff-email" className="text-base font-semibold">
          Email
        </Label>
        <Input
          id="staff-email"
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={200}
          autoCapitalize="none"
          className="h-14 text-base"
        />
        {!emailValid && <p className="text-sm font-medium text-destructive">Enter a valid email address.</p>}
      </div>

      <div className="space-y-1.5">
        <p className="text-base font-semibold">Paid through (finance vendor)</p>
        <VendorPicker value={vendorId} onChange={setVendorId} disabled={busy} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="staff-notes" className="text-base font-semibold">
          Notes
        </Label>
        <Textarea
          id="staff-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={1000}
          className="text-base"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" className="h-16 text-lg font-bold" disabled={!canSave}>
          {busy ? 'Saving...' : editing ? 'Save changes' : 'Add trimmer'}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" className="h-16 text-base" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
