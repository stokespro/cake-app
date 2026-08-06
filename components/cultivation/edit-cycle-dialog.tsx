'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { GrowRoom, RoomCycle, PHASE_CONFIG } from '@/types/cultivation'
import { getCycleStageLabel } from '@/lib/cultivation/helpers'
import { updateCycle, UpdateCyclePreview } from '@/actions/cultivation'

interface EditCycleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: GrowRoom | null
  activeCycles: RoomCycle[]
  onCompleted: () => void
  /** Admin-only affordance — mirrors updateCycle's server-side role gate. */
  canEditCycle?: boolean
}

type Step = 'edit' | 'confirm'

export function EditCycleDialog({
  open,
  onOpenChange,
  room,
  activeCycles,
  onCompleted,
  canEditCycle = false,
}: EditCycleDialogProps) {
  const [step, setStep] = useState<Step>('edit')
  const [selectedCycleId, setSelectedCycleId] = useState('')
  const [domeStart, setDomeStart] = useState('')
  const [vegStart, setVegStart] = useState('')
  const [flowerStart, setFlowerStart] = useState('')
  const [harvestDate, setHarvestDate] = useState('')
  const [dryStart, setDryStart] = useState('')
  const [trimStart, setTrimStart] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<UpdateCyclePreview | null>(null)

  function prefillFromCycle(cycle: RoomCycle) {
    setDomeStart(cycle.dome_start || '')
    setVegStart(cycle.veg_start || '')
    setFlowerStart(cycle.flower_start || '')
    setHarvestDate(cycle.harvest_date || '')
    setDryStart(cycle.dry_start || '')
    setTrimStart(cycle.trim_start || '')
    setNotes(cycle.notes || '')
  }

  // Reset state only on the open-transition (closed -> open), not on every
  // re-render that happens to produce a new `activeCycles` array identity
  // while the dialog is already open — the parent rebuilds that array from a
  // plain object map on every fetch, so keying a reset off it would blow
  // away in-progress edits (or bounce the user back to step 1) the moment
  // any polling/refresh landed.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setStep('edit')
      setPreview(null)
      const firstCycle = activeCycles[0]
      if (firstCycle) {
        setSelectedCycleId(firstCycle.id)
        prefillFromCycle(firstCycle)
      } else {
        setSelectedCycleId('')
      }
    }
    wasOpenRef.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleSelectCycle(id: string) {
    setSelectedCycleId(id)
    const cycle = activeCycles.find((c) => c.id === id)
    if (cycle) prefillFromCycle(cycle)
  }

  const selectedCycle = activeCycles.find((c) => c.id === selectedCycleId)

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault()
    if (!room || !selectedCycle) return

    setSaving(true)
    try {
      const result = await updateCycle({
        roomId: room.id,
        cycleId: selectedCycle.id,
        domeStart,
        vegStart,
        flowerStart,
        harvestDate,
        dryStart,
        trimStart,
        notes: notes.trim() || null,
        dryRun: true,
      })

      if ('error' in result) {
        toast.error(result.error)
      } else {
        setPreview(result)
        setStep('confirm')
      }
    } catch (err) {
      console.error('Preview cycle changes failed:', err)
      toast.error('Failed to preview changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleApply() {
    if (!room || !selectedCycle) return

    setSaving(true)
    try {
      const result = await updateCycle({
        roomId: room.id,
        cycleId: selectedCycle.id,
        domeStart,
        vegStart,
        flowerStart,
        harvestDate,
        dryStart,
        trimStart,
        notes: notes.trim() || null,
        dryRun: false,
      })

      if ('error' in result) {
        toast.error(result.error)
      } else {
        toast.success(
          `Cycle updated. ${result.tasksRescheduled} task${result.tasksRescheduled === 1 ? '' : 's'} rescheduled` +
            (result.tasksPreserved > 0
              ? `, ${result.tasksPreserved} completed task${result.tasksPreserved === 1 ? '' : 's'} unchanged.`
              : '.')
        )
        onOpenChange(false)
        onCompleted()
      }
    } catch (err) {
      console.error('Apply cycle changes failed:', err)
      toast.error('Failed to update cycle. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!room) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'confirm'
              ? `Confirm Changes — ${room.room_name}`
              : `Edit Cycle — ${room.room_name}`}
          </DialogTitle>
          <DialogDescription>
            {step === 'confirm'
              ? 'Review the tasks that will be rescheduled before applying.'
              : 'Correct milestone dates for an active cycle. Pending tasks are re-anchored to the corrected dates; completed tasks are never touched.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'edit' ? (
          <form onSubmit={handlePreview} className="space-y-4">
            {activeCycles.length === 0 && (
              <p className="text-sm text-muted-foreground">No active cycle to edit.</p>
            )}

            {activeCycles.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="ec-cycle">Select Cycle</Label>
                <Select value={selectedCycleId} onValueChange={handleSelectCycle}>
                  <SelectTrigger id="ec-cycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCycles.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        Cycle #{c.cycle_number || '?'} —{' '}
                        {getCycleStageLabel(c.current_stage, c.flower_start)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedCycle && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="ec-dome" className="text-xs">
                      {PHASE_CONFIG.dome.label} Start *
                    </Label>
                    <Input
                      id="ec-dome"
                      type="date"
                      value={domeStart}
                      onChange={(e) => setDomeStart(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ec-veg" className="text-xs">
                      {PHASE_CONFIG.veg.label} Start *
                    </Label>
                    <Input
                      id="ec-veg"
                      type="date"
                      value={vegStart}
                      onChange={(e) => setVegStart(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ec-flower" className="text-xs">
                      {PHASE_CONFIG.flower.label} Start *
                    </Label>
                    <Input
                      id="ec-flower"
                      type="date"
                      value={flowerStart}
                      onChange={(e) => setFlowerStart(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ec-harvest" className="text-xs">
                      {PHASE_CONFIG.harvest.label} Date *
                    </Label>
                    <Input
                      id="ec-harvest"
                      type="date"
                      value={harvestDate}
                      onChange={(e) => setHarvestDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ec-dry" className="text-xs">
                      {PHASE_CONFIG.dry.label} Start *
                    </Label>
                    <Input
                      id="ec-dry"
                      type="date"
                      value={dryStart}
                      onChange={(e) => setDryStart(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ec-trim" className="text-xs">
                      {PHASE_CONFIG.trim.label} Start *
                    </Label>
                    <Input
                      id="ec-trim"
                      type="date"
                      value={trimStart}
                      onChange={(e) => setTrimStart(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ec-notes">Notes</Label>
                  <Textarea
                    id="ec-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional cycle notes..."
                    rows={3}
                  />
                </div>

                {!canEditCycle && (
                  <p className="text-sm text-amber-600">
                    You don&apos;t have permission to edit cycle dates.
                  </p>
                )}
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !selectedCycle || !canEditCycle}>
                {saving ? 'Checking...' : 'Preview Changes'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            {preview && (
              <>
                <div className="rounded-md border p-3 space-y-1 text-sm">
                  <p className="font-medium">
                    {preview.tasksRescheduled} task
                    {preview.tasksRescheduled === 1 ? '' : 's'} will be rescheduled
                    {preview.tasksPreserved > 0 && (
                      <>
                        {' '}
                        · {preview.tasksPreserved} completed task
                        {preview.tasksPreserved === 1 ? '' : 's'} unchanged
                      </>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {preview.tasksUnchanged} pending task
                    {preview.tasksUnchanged === 1 ? '' : 's'} already correct
                    {preview.adhocSkipped > 0 && (
                      <>
                        {' '}
                        · {preview.adhocSkipped} ad-hoc/recurring task
                        {preview.adhocSkipped === 1 ? '' : 's'} left alone
                      </>
                    )}
                  </p>
                  <p className="text-xs font-medium text-emerald-600">
                    Completed work is never rewritten.
                  </p>
                </div>

                {preview.changes.length > 0 && (
                  <>
                    <div className="max-h-64 overflow-y-auto rounded-md border divide-y text-xs">
                      {preview.changes.map((c, i) => (
                        <div key={i} className="p-2">
                          <span className="font-medium">{c.title}</span>
                          <span className="text-muted-foreground">
                            {' '}
                            — {c.phase}: {c.from} → {c.to}
                          </span>
                        </div>
                      ))}
                    </div>
                    {preview.changes.length < preview.tasksRescheduled && (
                      <p className="text-xs text-muted-foreground">
                        Showing the first {preview.changes.length} of {preview.tasksRescheduled}{' '}
                        changes.
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('edit')}
                disabled={saving}
              >
                Back
              </Button>
              <Button type="button" onClick={handleApply} disabled={saving || !canEditCycle}>
                {saving ? 'Applying...' : 'Apply Changes'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
