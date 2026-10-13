'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ReasonPicker, reasonIsValid } from './reason-picker'

interface ReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  chips: readonly string[]
  confirmLabel: string
  destructive?: boolean
  /** Return true when the action worked (the dialog closes), false to stay open. */
  onConfirm: (reason: string) => Promise<boolean>
}

/** A confirm step that needs a written reason. Used for release, void, reopen and retire / lost. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  chips,
  confirmLabel,
  destructive,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setReason('')
      setBusy(false)
    }
  }, [open])

  async function confirm() {
    if (!reasonIsValid(reason) || busy) return
    setBusy(true)
    const done = await onConfirm(reason.trim())
    setBusy(false)
    if (done) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ReasonPicker id="reason-dialog-reason" chips={chips} value={reason} onChange={setReason} />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            className="font-semibold"
            disabled={!reasonIsValid(reason) || busy}
            onClick={confirm}
          >
            {busy ? 'Working...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
