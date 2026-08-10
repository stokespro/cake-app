'use client'

import { useState, useEffect } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { createTask, updateTask } from '@/actions/cultivation'
import type { CultivationTask, GrowRoom, RoomCycle, TaskPriority } from '@/types/cultivation'
import { getCycleStageLabel } from '@/lib/cultivation/helpers'

interface UserOption {
  id: string
  name: string
  role?: string
}

interface CreateTaskSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: CultivationTask | null // null = create mode, non-null = edit mode
  rooms: GrowRoom[]
  users: UserOption[]
  userId: string
  cyclesByRoom: Record<string, RoomCycle[]>
  onSaved: () => void
}

export function CreateTaskSheet({
  open,
  onOpenChange,
  task,
  rooms,
  users,
  userId,
  cyclesByRoom,
  onSaved,
}: CreateTaskSheetProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [roomId, setRoomId] = useState<string>('none')
  const [cycleId, setCycleId] = useState<string>('none')
  const [dueDate, setDueDate] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [estimatedMinutes, setEstimatedMinutes] = useState('')
  const [frequency, setFrequency] = useState<string>('')
  const [dayOfWeek, setDayOfWeek] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const isEditing = !!task

  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description || '')
      setRoomId(task.room_id || 'none')
      setCycleId(task.room_cycle_id ?? 'none')
      setDueDate(task.due_date)
      setPriority(task.priority)
      // Prefer the full assignee list; fall back to the legacy single
      // assigned_to for tasks created before this migration.
      setAssigneeIds(
        task.assignees && task.assignees.length > 0
          ? task.assignees.map((a) => a.id)
          : task.assigned_to
            ? [task.assigned_to]
            : []
      )
      setEstimatedMinutes(task.estimated_minutes?.toString() || '')
      setFrequency(task.frequency || '')
      setDayOfWeek(task.day_of_week?.toString() || '')
    } else {
      setTitle('')
      setDescription('')
      setRoomId('none')
      setCycleId('none')
      setDueDate('')
      setPriority('medium')
      setAssigneeIds([])
      setEstimatedMinutes('')
      setFrequency('')
      setDayOfWeek('')
    }
  }, [task, open])

  // Active cycles for the currently selected room. If the task being edited
  // is linked to a cycle that's no longer active (so it won't be in this
  // list), append it — labeled as completed — so the Select doesn't render
  // blank and saving doesn't silently wipe the link.
  const activeForRoom = roomId === 'none' ? [] : (cyclesByRoom[roomId] ?? [])
  const cycleOptions =
    task?.cycle && task.room_id === roomId && !activeForRoom.some((c) => c.id === task.cycle!.id)
      ? [...activeForRoom, { ...task.cycle, room_id: roomId } as RoomCycle]
      : activeForRoom
  const staleCycleId = task?.cycle && !activeForRoom.some((c) => c.id === task.cycle!.id) ? task.cycle.id : null

  function handleRoomChange(value: string) {
    setRoomId(value)
    // Reset the cycle selection whenever the room changes — a cycle from
    // the previous room is never valid for the new one. Doing this inside
    // the handler (rather than an effect keyed on the cycles map) avoids
    // clobbering an in-progress edit when a background refetch produces a
    // new `cyclesByRoom` array identity while the sheet is open.
    setCycleId('none')
  }

  function toggleAssignee(userId: string, checked: boolean) {
    setAssigneeIds((prev) =>
      checked ? [...prev, userId] : prev.filter((id) => id !== userId)
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    if (!dueDate) {
      toast.error('Due date is required')
      return
    }

    setSaving(true)

    const sharedPayload = {
      title: title.trim(),
      description: description.trim() || null,
      room_id: roomId === 'none' ? null : roomId,
      // A facility-wide task (no room) must never carry a cycle.
      room_cycle_id: roomId === 'none' || cycleId === 'none' ? null : cycleId,
      due_date: dueDate,
      priority,
      assignee_ids: assigneeIds,
      estimated_minutes: estimatedMinutes ? parseInt(estimatedMinutes) : null,
      frequency: frequency && frequency !== 'none' ? frequency : null,
      day_of_week: dayOfWeek ? parseInt(dayOfWeek) : null,
    }

    if (isEditing) {
      const result = await updateTask(task.id, {
        ...sharedPayload,
        task_type: frequency && frequency !== 'none' ? 'recurring' : (task.task_type === 'scheduled' ? 'scheduled' : 'adhoc'),
      })
      if (result.error) {
        toast.error(result.error)
        setSaving(false)
        return
      }
      toast.success('Task updated')
    } else {
      const result = await createTask({
        ...sharedPayload,
        task_type: frequency && frequency !== 'none' ? 'recurring' : 'adhoc',
        created_by: userId,
      })
      if (result.error) {
        toast.error(result.error)
        setSaving(false)
        return
      }
      toast.success('Task created')
    }

    setSaving(false)
    onOpenChange(false)
    onSaved()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{isEditing ? 'Edit Task' : 'New Task'}</SheetTitle>
          <SheetDescription>
            {isEditing
              ? 'Update the task details.'
              : 'Create a new cultivation task. Set a frequency for recurring tasks.'}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title *</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Check pH levels in Room 1"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details about the task..."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-room">Room</Label>
            <Select value={roomId} onValueChange={handleRoomChange}>
              <SelectTrigger id="task-room">
                <SelectValue placeholder="Select room" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Room (facility-wide)</SelectItem>
                {rooms.map((room) => (
                  <SelectItem key={room.id} value={room.id}>
                    {room.room_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {roomId !== 'none' && cycleOptions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="task-cycle">Cycle</Label>
              <Select value={cycleId} onValueChange={setCycleId}>
                <SelectTrigger id="task-cycle">
                  <SelectValue placeholder="No Cycle" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Cycle</SelectItem>
                  {cycleOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      Cycle #{c.cycle_number || '?'} — {getCycleStageLabel(c.current_stage, c.flower_start)}
                      {c.id === staleCycleId ? ' (completed)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {cycleId !== 'none' && (
                <p className="text-xs text-muted-foreground">
                  Task will close out when this cycle ends.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="task-due-date">Due Date *</Label>
            <Input
              id="task-due-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-priority">Priority *</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
              <SelectTrigger id="task-priority">
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Frequency</Label>
            <Select value={frequency || 'none'} onValueChange={setFrequency}>
              <SelectTrigger>
                <SelectValue placeholder="One-time (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">One-time</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Biweekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(frequency === 'weekly' || frequency === 'biweekly') && (
            <div className="space-y-2">
              <Label>Day of Week</Label>
              <Select value={dayOfWeek || '1'} onValueChange={setDayOfWeek}>
                <SelectTrigger>
                  <SelectValue placeholder="Monday (default)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Monday</SelectItem>
                  <SelectItem value="2">Tuesday</SelectItem>
                  <SelectItem value="3">Wednesday</SelectItem>
                  <SelectItem value="4">Thursday</SelectItem>
                  <SelectItem value="5">Friday</SelectItem>
                  <SelectItem value="6">Saturday</SelectItem>
                  <SelectItem value="7">Sunday</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Assigned To</Label>
            {users.length === 0 ? (
              <p className="text-sm text-muted-foreground">No eligible users found.</p>
            ) : (
              <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                {users.map((u) => {
                  const checked = assigneeIds.includes(u.id)
                  return (
                    <label
                      key={u.id}
                      htmlFor={`task-assignee-${u.id}`}
                      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer active:bg-muted/50"
                    >
                      <Checkbox
                        id={`task-assignee-${u.id}`}
                        checked={checked}
                        onCheckedChange={(v) => toggleAssignee(u.id, v === true)}
                      />
                      <span className="text-sm">
                        {u.name}
                        {u.role ? (
                          <span className="text-muted-foreground text-xs ml-1">({u.role})</span>
                        ) : null}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {assigneeIds.length === 0 && (
              <p className="text-xs text-muted-foreground">No one selected — task will be unassigned.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-estimated-minutes">Estimated Minutes</Label>
            <Input
              id="task-estimated-minutes"
              type="number"
              min="1"
              value={estimatedMinutes}
              onChange={(e) => setEstimatedMinutes(e.target.value)}
              placeholder="e.g., 30"
            />
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
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Task'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
