'use client'

import { useState, useEffect } from 'react'
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
import { createTemplateTask, updateTemplateTask } from '@/actions/cultivation'
import { TemplateTask, TaskPriority, STAGE_ORDER, PHASE_CONFIG, PipelineStage } from '@/types/cultivation'

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

const STAGE_OPTIONS = STAGE_ORDER.map((s) => ({
  value: s,
  label: PHASE_CONFIG[s].label,
}))

interface TemplateTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateId: string
  task: TemplateTask | null
  maxSortOrder: number
  defaultDay?: number
  defaultStage?: string
  isMasterTemplate?: boolean
  onSaved: () => void
}

export function TemplateTaskDialog({
  open,
  onOpenChange,
  templateId,
  task,
  maxSortOrder,
  defaultDay,
  defaultStage,
  isMasterTemplate,
  onSaved,
}: TemplateTaskDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dayNumber, setDayNumber] = useState('1')
  const [estimatedMinutes, setEstimatedMinutes] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [stage, setStage] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const isEditing = !!task

  useEffect(() => {
    if (task) {
      setName(task.name)
      setDescription(task.description || '')
      setDayNumber(String(task.day_number))
      setEstimatedMinutes(
        task.estimated_minutes !== null ? String(task.estimated_minutes) : ''
      )
      setPriority(task.priority)
      setStage(task.stage || '')
    } else {
      setName('')
      setDescription('')
      setDayNumber(defaultDay !== undefined ? String(defaultDay) : '1')
      setEstimatedMinutes('')
      setPriority('medium')
      setStage(defaultStage || '')
    }
  }, [task, open, defaultDay, defaultStage])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!name.trim()) {
      toast.error('Task name is required')
      return
    }

    const day = parseInt(dayNumber, 10)
    if (isNaN(day) || day < -30 || day > 365) {
      toast.error('Day must be between -30 and 365')
      return
    }

    if (isMasterTemplate && !stage) {
      toast.error('Stage is required for master template tasks')
      return
    }

    const minutes = estimatedMinutes
      ? parseInt(estimatedMinutes, 10)
      : null
    if (estimatedMinutes && (isNaN(minutes!) || minutes! < 1)) {
      toast.error('Estimated minutes must be a positive number')
      return
    }

    setSaving(true)

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      day_number: day,
      estimated_minutes: minutes,
      priority,
      stage: stage && stage !== 'none' ? stage : null,
    }

    if (isEditing) {
      const result = await updateTemplateTask(task.id, payload)
      if (result.error) {
        toast.error(result.error)
        setSaving(false)
        return
      }
      toast.success('Task updated')
    } else {
      const result = await createTemplateTask(templateId, payload, maxSortOrder + 1)
      if (result.error) {
        toast.error(result.error)
        setSaving(false)
        return
      }
      toast.success('Task added')
    }

    setSaving(false)
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Task' : 'Add Task'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the task details.'
              : 'Add a new task to this template.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-name">Name *</Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Check pH levels"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-stage">
              Stage {isMasterTemplate ? '*' : ''}
            </Label>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger id="task-stage">
                <SelectValue placeholder="Select stage" />
              </SelectTrigger>
              <SelectContent>
                {!isMasterTemplate && (
                  <SelectItem value="none">None</SelectItem>
                )}
                {STAGE_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-day">Day within Phase *</Label>
            <Input
              id="task-day"
              type="number"
              min={-30}
              max={365}
              value={dayNumber}
              onChange={(e) => setDayNumber(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Positive = days after phase starts. Negative = days before (prep tasks).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="task-minutes">Est. Minutes</Label>
              <Input
                id="task-minutes"
                type="number"
                min={1}
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
                placeholder="e.g., 30"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="task-priority">Priority *</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as TaskPriority)}
              >
                <SelectTrigger id="task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : isEditing ? 'Update' : 'Add Task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
