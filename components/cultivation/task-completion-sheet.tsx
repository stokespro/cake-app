'use client'

import { useEffect, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { completeTask } from '@/actions/cultivation'
import { getSwitcherAdvancePreview } from '@/lib/cultivation/helpers'
import { PHASE_CONFIG, type PipelineStage } from '@/types/cultivation'
import type { CultivationTask } from '@/types/cultivation'

interface TaskCompletionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: CultivationTask | null
  userId: string
  onCompleted: () => void
}

export function TaskCompletionSheet({
  open,
  onOpenChange,
  task,
  userId,
  onCompleted,
}: TaskCompletionSheetProps) {
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  // Second confirmation step, shown only when this task is a phase switcher
  // that would actually advance its cycle (see getSwitcherAdvancePreview —
  // the single shared "does this need confirming?" check, also used by the
  // TV board completion flow). Reset whenever the sheet targets a new task
  // or closes, so a leftover confirm state can't leak onto the next task.
  const [confirmingAdvance, setConfirmingAdvance] = useState(false)

  const advanceTo = task ? getSwitcherAdvancePreview(task) : null
  const advanceLabel = advanceTo ? PHASE_CONFIG[advanceTo as PipelineStage]?.label ?? advanceTo : null

  useEffect(() => {
    if (!open) setConfirmingAdvance(false)
  }, [open, task?.id])

  async function doComplete() {
    if (!task) return

    setSaving(true)
    const result = await completeTask({
      taskId: task.id,
      completedBy: userId,
      notes: notes.trim() || null,
    })

    if ('error' in result) {
      toast.error(result.error)
      setSaving(false)
      return
    }

    toast.success(
      result.advancedTo
        ? `Task completed. Advanced to ${PHASE_CONFIG[result.advancedTo as PipelineStage]?.label ?? result.advancedTo}.`
        : 'Task completed'
    )
    setSaving(false)
    setConfirmingAdvance(false)
    setNotes('')
    onOpenChange(false)
    onCompleted()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!task) return

    // Non-switcher tasks (and switchers that wouldn't actually advance)
    // complete immediately, exactly as before this feature existed.
    if (!advanceTo) {
      doComplete()
      return
    }
    setConfirmingAdvance(true)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="overflow-y-auto w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Complete Task</SheetTitle>
            <SheetDescription>
              {task?.title}
            </SheetDescription>
          </SheetHeader>

          <form onSubmit={handleSubmit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="completion-notes">Completion Notes</Label>
              <Textarea
                id="completion-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Observations, readings, notes..."
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                Optional but encouraged — record any observations or measurements.
              </p>
            </div>

            <SheetFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Mark as Complete'}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {/* Phase-switcher advance confirmation — folded in as a second step
          rather than stacking on top of the sheet's own submit, so Cancel
          here leaves the sheet open (in case notes need editing) while
          Confirm proceeds straight to completion. */}
      <AlertDialog open={confirmingAdvance} onOpenChange={setConfirmingAdvance}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Advance cycle to {advanceLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              By completing this task you are also advancing this cycle to {advanceLabel}. Please confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doComplete} disabled={saving}>
              {saving ? 'Completing...' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
