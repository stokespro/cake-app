'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
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
import {
  Plus,
  Edit2,
  Trash2,
  ArrowLeft,
  Clock,
  ChevronDown,
  ChevronRight,
  ListTodo,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth, canManageCultivation } from '@/lib/auth-context'
import {
  CycleTemplate,
  TemplateTask,
  GrowPhase,
  PHASE_CONFIG,
  TaskPriority,
  STAGE_ORDER,
  PipelineStage,
} from '@/types/cultivation'
import { TemplateSheet } from '@/components/cultivation/template-sheet'
import {
  TemplateTaskDialog,
} from '@/components/cultivation/template-task-dialog'
import {
  getCycleTemplates,
  getTemplateTasks,
  toggleTemplateActive,
  deleteCycleTemplate,
  deleteTemplateTask as deleteTemplateTaskAction,
} from '@/actions/cultivation'

const PHASE_BADGE_CLASSES: Record<string, string> = {
  empty: 'bg-gray-500 text-white',
  dome: 'bg-teal-600 text-white',
  veg: 'bg-green-600 text-white',
  flower: 'bg-purple-600 text-white',
  harvest: 'bg-amber-600 text-white',
  dry: 'bg-orange-600 text-white',
  trim: 'bg-rose-600 text-white',
  master: 'bg-indigo-600 text-white',
}

const PRIORITY_BADGE_CLASSES: Record<TaskPriority, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-500 text-white',
  low: 'bg-blue-500 text-white',
}

interface TemplateWithCount extends CycleTemplate {
  template_tasks: { id: string }[]
}

export default function TemplatesPage() {
  const { user } = useAuth()
  const canManage = user ? canManageCultivation(user.role) : false

  const [templates, setTemplates] = useState<TemplateWithCount[]>([])
  const [loading, setLoading] = useState(true)

  // Template sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<CycleTemplate | null>(null)

  // Delete template state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingTemplate, setDeletingTemplate] = useState<CycleTemplate | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Expanded template (inline task view)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<TemplateTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)

  // Task dialog state
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<TemplateTask | null>(null)
  const [addTaskDay, setAddTaskDay] = useState<number | undefined>(undefined)
  const [addTaskStage, setAddTaskStage] = useState<string | undefined>(undefined)

  // Delete task state
  const [deleteTaskDialogOpen, setDeleteTaskDialogOpen] = useState(false)
  const [deletingTask, setDeletingTask] = useState<TemplateTask | null>(null)
  const [deletingTaskLoading, setDeletingTaskLoading] = useState(false)

  const fetchTemplates = useCallback(async () => {
    const result = await getCycleTemplates()
    if (result.error) {
      toast.error(result.error)
    } else {
      setTemplates(result.data as TemplateWithCount[])
    }
    setLoading(false)
  }, [])

  const fetchTasks = useCallback(async (templateId: string) => {
    setTasksLoading(true)
    const result = await getTemplateTasks(templateId)
    if (result.error) {
      toast.error(result.error)
    } else {
      setTasks(result.data ?? [])
    }
    setTasksLoading(false)
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  function handleExpand(templateId: string) {
    if (expandedId === templateId) {
      setExpandedId(null)
      setTasks([])
    } else {
      setExpandedId(templateId)
      fetchTasks(templateId)
    }
  }

  function handleNewTemplate() {
    setEditingTemplate(null)
    setSheetOpen(true)
  }

  function handleEditTemplate(template: CycleTemplate) {
    setEditingTemplate(template)
    setSheetOpen(true)
  }

  function handleDeleteTemplate(template: CycleTemplate) {
    setDeletingTemplate(template)
    setDeleteDialogOpen(true)
  }

  async function confirmDeleteTemplate() {
    if (!deletingTemplate) return
    setDeleting(true)

    const result = await deleteCycleTemplate(deletingTemplate.id)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Template deleted')
      if (expandedId === deletingTemplate.id) {
        setExpandedId(null)
        setTasks([])
      }
      fetchTemplates()
    }
    setDeleting(false)
    setDeleteDialogOpen(false)
    setDeletingTemplate(null)
  }

  async function handleToggleActive(template: TemplateWithCount) {
    const result = await toggleTemplateActive(template.id, !template.is_active)
    if (result.error) {
      toast.error(result.error)
    } else {
      fetchTemplates()
    }
  }

  // Task actions
  function handleAddTask(day?: number, stage?: string) {
    setEditingTask(null)
    setAddTaskDay(day)
    setAddTaskStage(stage)
    setTaskDialogOpen(true)
  }

  function handleEditTask(task: TemplateTask) {
    setEditingTask(task)
    setAddTaskDay(undefined)
    setAddTaskStage(undefined)
    setTaskDialogOpen(true)
  }

  function handleDeleteTask(task: TemplateTask) {
    setDeletingTask(task)
    setDeleteTaskDialogOpen(true)
  }

  async function confirmDeleteTask() {
    if (!deletingTask) return
    setDeletingTaskLoading(true)

    const result = await deleteTemplateTaskAction(deletingTask.id)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Task deleted')
      if (expandedId) fetchTasks(expandedId)
      fetchTemplates()
    }
    setDeletingTaskLoading(false)
    setDeleteTaskDialogOpen(false)
    setDeletingTask(null)
  }

  function handleTaskSaved() {
    if (expandedId) fetchTasks(expandedId)
    fetchTemplates()
  }

  // Group tasks by day (for phase templates)
  function getTasksByDay(taskList: TemplateTask[]) {
    const grouped: Record<number, TemplateTask[]> = {}
    for (const t of taskList) {
      if (!grouped[t.day_number]) grouped[t.day_number] = []
      grouped[t.day_number].push(t)
    }
    return Object.entries(grouped)
      .map(([day, dayTasks]) => ({
        day: parseInt(day, 10),
        tasks: dayTasks,
      }))
      .sort((a, b) => a.day - b.day)
  }

  // Group tasks by stage then day (for master templates).
  // Always returns one group per STAGE_ORDER entry (even with zero tasks),
  // plus a trailing "Unassigned" group for tasks with a null/unrecognized stage.
  function getTasksByStage(taskList: TemplateTask[]) {
    const grouped: Record<string, TemplateTask[]> = {}
    const stageSet = new Set<string>(STAGE_ORDER)
    for (const t of taskList) {
      const stageKey = t.stage && stageSet.has(t.stage) ? t.stage : 'unassigned'
      if (!grouped[stageKey]) grouped[stageKey] = []
      grouped[stageKey].push(t)
    }
    const sortTasks = (a: TemplateTask, b: TemplateTask) =>
      a.day_number - b.day_number || a.sort_order - b.sort_order

    const groups = STAGE_ORDER.map((stage) => ({
      stage: stage as PipelineStage | 'unassigned',
      label: PHASE_CONFIG[stage as GrowPhase]?.label || stage,
      tasks: (grouped[stage] || []).sort(sortTasks),
    }))

    if (grouped.unassigned?.length) {
      groups.push({
        stage: 'unassigned',
        label: 'Unassigned',
        tasks: grouped.unassigned.sort(sortTasks),
      })
    }

    return groups
  }

  function formatPhaseDay(task: TemplateTask): string {
    const stageLabel = task.stage ? (PHASE_CONFIG[task.stage as GrowPhase]?.label || task.stage) : ''
    if (task.day_number < 0) {
      return `${stageLabel} Day ${task.day_number} (prep)`
    }
    return `${stageLabel} Day ${task.day_number}`
  }

  function renderTaskRow(task: TemplateTask, showStage?: boolean) {
    return (
      <div
        key={task.id}
        className="grid grid-cols-[1fr_80px_80px_72px] gap-2 px-3 py-2 text-sm items-center border-b last:border-b-0"
      >
        <div className="truncate font-medium">
          {showStage && task.stage && (
            <Badge className={`${PHASE_BADGE_CLASSES[task.stage] || 'bg-gray-500 text-white'} text-[10px] mr-1.5`}>
              {PHASE_CONFIG[task.stage as GrowPhase]?.label || task.stage}
            </Badge>
          )}
          {formatPhaseDay(task)}: {task.name}
        </div>
        <div>
          <Badge
            className={`text-xs ${PRIORITY_BADGE_CLASSES[task.priority]}`}
          >
            {task.priority}
          </Badge>
        </div>
        <div className="text-muted-foreground flex items-center gap-1">
          {task.estimated_minutes ? (
            <>
              <Clock className="h-3 w-3" />
              {task.estimated_minutes}m
            </>
          ) : (
            '\u2014'
          )}
        </div>
        {canManage && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleEditTask(task)}
            >
              <Edit2 className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleDeleteTask(task)}
            >
              <Trash2 className="h-3 w-3 text-destructive" />
            </Button>
          </div>
        )}
      </div>
    )
  }

  function renderTaskCard(task: TemplateTask, showStage?: boolean) {
    return (
      <div
        key={task.id}
        className="border rounded-md p-3 space-y-2"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-sm">
            {showStage && task.stage && (
              <Badge className={`${PHASE_BADGE_CLASSES[task.stage] || 'bg-gray-500 text-white'} text-[10px] mr-1.5`}>
                {PHASE_CONFIG[task.stage as GrowPhase]?.label || task.stage}
              </Badge>
            )}
            {formatPhaseDay(task)}: {task.name}
          </span>
          <Badge
            className={`text-xs shrink-0 ${PRIORITY_BADGE_CLASSES[task.priority]}`}
          >
            {task.priority}
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {task.estimated_minutes && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {task.estimated_minutes} min
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleEditTask(task)}
            >
              <Edit2 className="h-3 w-3 mr-1" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive"
              onClick={() => handleDeleteTask(task)}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Delete
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading templates...</div>
      </div>
    )
  }

  const expandedTemplate = templates.find((t) => t.id === expandedId)
  const expandedDurationDays = expandedTemplate?.duration_days ?? 0
  const expandedIsMaster = expandedTemplate?.template_type === 'master'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/cultivation">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Cycle Templates
            </h1>
            <p className="text-muted-foreground">
              Define task schedules for growth phases or full pipeline cycles
            </p>
          </div>
        </div>
        {canManage && (
          <Button onClick={handleNewTemplate}>
            <Plus className="h-4 w-4 mr-2" />
            New Template
          </Button>
        )}
      </div>

      {/* Template List */}
      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ListTodo className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold">No templates yet</h3>
            <p className="text-muted-foreground mt-1">
              Create a cycle template to define tasks for a growth phase.
            </p>
            {canManage && (
              <Button onClick={handleNewTemplate} className="mt-4">
                <Plus className="h-4 w-4 mr-2" />
                Create First Template
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {templates.map((template) => {
            const isMaster = template.template_type === 'master'
            const phaseConfig = isMaster ? null : PHASE_CONFIG[template.phase as GrowPhase]
            const isExpanded = expandedId === template.id
            const taskCount = template.template_tasks?.length ?? 0

            return (
              <Card key={template.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="flex-1 cursor-pointer"
                      onClick={() => handleExpand(template.id)}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <CardTitle className="text-base">
                          {template.name}
                        </CardTitle>
                        <Badge
                          className={
                            isMaster
                              ? PHASE_BADGE_CLASSES.master
                              : PHASE_BADGE_CLASSES[template.phase as string] || 'bg-gray-500 text-white'
                          }
                        >
                          {isMaster ? 'Master' : phaseConfig?.label || template.phase}
                        </Badge>
                        {template.duration_days != null && template.duration_days > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {template.duration_days} days
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
                        </span>
                      </div>
                      {template.description && (
                        <p className="text-sm text-muted-foreground mt-1 ml-6">
                          {template.description}
                        </p>
                      )}
                    </div>

                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={template.is_active}
                          onCheckedChange={() => handleToggleActive(template)}
                          aria-label="Toggle active"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditTemplate(template)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteTemplate(template)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>

                {/* Expanded task view */}
                {isExpanded && (
                  <CardContent className="pt-0">
                    {tasksLoading ? (
                      <div className="text-sm text-muted-foreground py-4">
                        Loading tasks...
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Duration indicator */}
                        {expandedDurationDays > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {expandedIsMaster ? 'Cycle' : 'Phase'} duration: {expandedDurationDays} days
                          </p>
                        )}

                        {expandedIsMaster ? (
                          // Master template: group by stage, one group per STAGE_ORDER
                          // entry (even with zero tasks) plus a trailing Unassigned group
                          getTasksByStage(tasks).map(({ stage, label, tasks: stageTasks }) => (
                            <div key={stage}>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <Badge className={PHASE_BADGE_CLASSES[stage] || 'bg-gray-500 text-white'}>
                                    {label}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground">
                                    {stageTasks.length} {stageTasks.length === 1 ? 'task' : 'tasks'}
                                  </span>
                                </div>
                                {canManage && stage !== 'unassigned' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleAddTask(undefined, stage)}
                                  >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Add
                                  </Button>
                                )}
                              </div>

                              {stageTasks.length === 0 ? (
                                <p className="text-xs text-muted-foreground mb-3">
                                  No tasks in this phase.
                                </p>
                              ) : (
                                <>
                                  {/* Desktop table */}
                                  <div className="hidden sm:block">
                                    <div className="border rounded-md mb-3">
                                      <div className="grid grid-cols-[1fr_80px_80px_72px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/50">
                                        <div>Task</div>
                                        <div>Priority</div>
                                        <div>Est. Time</div>
                                        <div></div>
                                      </div>
                                      {stageTasks.map((task) => renderTaskRow(task, false))}
                                    </div>
                                  </div>

                                  {/* Mobile cards */}
                                  <div className="sm:hidden space-y-2 mb-3">
                                    {stageTasks.map((task) => renderTaskCard(task, false))}
                                  </div>
                                </>
                              )}
                            </div>
                          ))
                        ) : tasks.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-4 text-center">
                            No tasks defined yet.
                          </div>
                        ) : (
                          // Phase template: group by day (original behavior)
                          getTasksByDay(tasks).map(({ day, tasks: dayTasks }) => (
                            <div key={day}>
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-semibold">
                                  Day {day}
                                </h4>
                                {canManage && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleAddTask(day)}
                                  >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Add
                                  </Button>
                                )}
                              </div>

                              {/* Desktop table */}
                              <div className="hidden sm:block">
                                <div className="border rounded-md">
                                  <div className="grid grid-cols-[1fr_80px_80px_72px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/50">
                                    <div>Task</div>
                                    <div>Priority</div>
                                    <div>Est. Time</div>
                                    <div></div>
                                  </div>
                                  {dayTasks.map((task) => renderTaskRow(task, false))}
                                </div>
                              </div>

                              {/* Mobile cards */}
                              <div className="sm:hidden space-y-2">
                                {dayTasks.map((task) => renderTaskCard(task, false))}
                              </div>
                            </div>
                          ))
                        )}

                        {/* General add task button */}
                        {canManage && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAddTask()}
                            className="w-full"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add Task
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* Template Sheet */}
      <TemplateSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        template={editingTemplate}
        userId={user?.id ?? ''}
        onSaved={fetchTemplates}
      />

      {/* Task Dialog */}
      {expandedId && (
        <TemplateTaskDialog
          open={taskDialogOpen}
          onOpenChange={setTaskDialogOpen}
          templateId={expandedId}
          task={editingTask}
          maxSortOrder={
            tasks.length > 0
              ? Math.max(...tasks.map((t) => t.sort_order ?? 0))
              : 0
          }
          defaultDay={addTaskDay}
          defaultStage={addTaskStage}
          isMasterTemplate={expandedIsMaster}
          onSaved={handleTaskSaved}
        />
      )}

      {/* Delete Template Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deletingTemplate?.name}
              &quot;? This will also delete all tasks within this template. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteTemplate}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Task Confirmation */}
      <AlertDialog
        open={deleteTaskDialogOpen}
        onOpenChange={setDeleteTaskDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deletingTask?.name}&quot;?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingTaskLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteTask}
              disabled={deletingTaskLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingTaskLoading ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
