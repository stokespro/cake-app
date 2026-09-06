'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import {
  getTasks,
  getArchivedTasks,
  getAssignableUsers,
  updateTask,
  updateTaskStatus,
  archiveTask,
  restoreTask,
} from '@/actions/tasks'
import type { TaskWithCustomer, AssignableUser } from '@/actions/tasks'
import type { TaskStatus } from '@/types/database'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorState } from '@/components/ui/error-state'
import {
  Plus,
  Search,
  Calendar,
  CheckCircle,
  Clock,
  AlertCircle,
  Pencil,
  Archive,
  ArchiveRestore,
  Loader2,
  XCircle,
  Circle,
  User as UserIcon,
} from 'lucide-react'
import { format } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Status metadata (SPRO-73): todo → in_progress → done, plus cancelled.
// ---------------------------------------------------------------------------

const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled']

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress']

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as string[]).includes(value)
}

function getStatusBadge(status: TaskStatus) {
  switch (status) {
    case 'todo':
      return <Badge variant="outline">To Do</Badge>
    case 'in_progress':
      return <Badge className="bg-blue-600">In Progress</Badge>
    case 'done':
      return <Badge className="bg-green-600">Done</Badge>
    case 'cancelled':
      return <Badge variant="secondary">Cancelled</Badge>
  }
}

interface EditFormState {
  title: string
  description: string
  due_date: string
  status: TaskStatus
  agent_id: string
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskWithCustomer[]>([])
  const [filteredTasks, setFilteredTasks] = useState<TaskWithCustomer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [assignees, setAssignees] = useState<AssignableUser[]>([])
  const [editingTask, setEditingTask] = useState<TaskWithCustomer | null>(null)
  const [editForm, setEditForm] = useState<EditFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<TaskWithCustomer | null>(null)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const { user, handleSessionError } = useAuth()

  const fetchTasks = useCallback(async (currentView: 'active' | 'archived') => {
    try {
      setError(null)
      const result = currentView === 'archived' ? await getArchivedTasks() : await getTasks()
      if (result.error) {
        console.error('Error fetching tasks:', result.error)
        if (handleSessionError(result.error)) return
        setError("Couldn't load tasks. Try again.")
        setTasks([])
        return
      }
      setTasks(result.data ?? [])
    } finally {
      setLoading(false)
    }
  }, [handleSessionError])

  useEffect(() => {
    setLoading(true)
    fetchTasks(view)
  }, [view, fetchTasks])

  useEffect(() => {
    filterTasksList()
  }, [tasks, searchTerm, filterStatus, filterPriority])

  const filterTasksList = () => {
    let filtered = [...tasks]

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(task =>
        task.title.toLowerCase().includes(term) ||
        task.description?.toLowerCase().includes(term) ||
        task.customer?.business_name?.toLowerCase().includes(term) ||
        task.customer?.license_name?.toLowerCase().includes(term) ||
        task.customer?.omma_license?.toLowerCase().includes(term) ||
        task.customer?.city?.toLowerCase().includes(term) ||
        task.assignee?.name?.toLowerCase().includes(term)
      )
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter(task => task.status === filterStatus)
    }

    if (filterPriority !== 'all') {
      filtered = filtered.filter(task => task.priority.toString() === filterPriority)
    }

    setFilteredTasks(filtered)
  }

  /** Current assignee or admin may edit/archive/restore (mirrors the server check). */
  const canManageTask = (task: TaskWithCustomer) =>
    !!user && (task.agent_id === user.id || user.role === 'admin')

  const loadAssignees = async () => {
    if (assignees.length > 0) return
    const result = await getAssignableUsers()
    if (result.error) {
      console.error('Error fetching assignable users:', result.error)
      if (handleSessionError(result.error)) return
      toast.error(result.error)
      return
    }
    setAssignees(result.data ?? [])
  }

  const handleStatusChange = async (task: TaskWithCustomer, status: string) => {
    if (!isTaskStatus(status) || status === task.status) return
    setPendingTaskId(task.id)
    try {
      const result = await updateTaskStatus(task.id, status)
      if (result.error) {
        console.error('Error updating task status:', result.error)
        if (handleSessionError(result.error)) return
        toast.error(result.error)
        return
      }
      await fetchTasks(view)
    } finally {
      setPendingTaskId(null)
    }
  }

  const openEditDialog = (task: TaskWithCustomer) => {
    setEditingTask(task)
    setEditForm({
      title: task.title,
      description: task.description ?? '',
      due_date: task.due_date,
      status: task.status,
      agent_id: task.agent_id,
    })
    loadAssignees()
  }

  const handleEditSave = async () => {
    if (!editingTask || !editForm) return
    setSaving(true)
    try {
      const result = await updateTask(editingTask.id, {
        title: editForm.title,
        description: editForm.description || null,
        due_date: editForm.due_date,
        status: editForm.status,
        agent_id: editForm.agent_id,
      })
      if (result.error) {
        console.error('Error updating task:', result.error)
        if (handleSessionError(result.error)) return
        toast.error(result.error)
        return
      }
      setEditingTask(null)
      setEditForm(null)
      toast.success('Task updated')
      await fetchTasks(view)
    } finally {
      setSaving(false)
    }
  }

  const handleArchiveConfirm = async () => {
    if (!archiveTarget) return
    const taskId = archiveTarget.id
    setArchiveTarget(null)
    setPendingTaskId(taskId)
    try {
      const result = await archiveTask(taskId)
      if (result.error) {
        console.error('Error archiving task:', result.error)
        if (handleSessionError(result.error)) return
        toast.error(result.error)
        return
      }
      toast.success('Task archived')
      await fetchTasks(view)
    } finally {
      setPendingTaskId(null)
    }
  }

  const handleRestore = async (task: TaskWithCustomer) => {
    setPendingTaskId(task.id)
    try {
      const result = await restoreTask(task.id)
      if (result.error) {
        console.error('Error restoring task:', result.error)
        if (handleSessionError(result.error)) return
        toast.error(result.error)
        return
      }
      toast.success('Task restored')
      await fetchTasks(view)
    } finally {
      setPendingTaskId(null)
    }
  }

  const getPriorityIcon = (priority: number) => {
    switch (priority) {
      case 1:
        return <AlertCircle className="h-4 w-4 text-red-500" />
      case 2:
        return <Clock className="h-4 w-4 text-yellow-500" />
      case 3:
        return <Clock className="h-4 w-4 text-blue-500" />
      default:
        return null
    }
  }

  const getPriorityLabel = (priority: number) => {
    switch (priority) {
      case 1:
        return 'High'
      case 2:
        return 'Medium'
      case 3:
        return 'Low'
      default:
        return 'Unknown'
    }
  }

  const getStatusIcon = (task: TaskWithCustomer) => {
    switch (task.status) {
      case 'done':
        return <CheckCircle className="h-5 w-5 text-green-500 mt-0.5" />
      case 'cancelled':
        return <XCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
      case 'in_progress':
        return <Circle className="h-5 w-5 text-blue-500 mt-0.5" />
      default:
        return getPriorityIcon(task.priority)
    }
  }

  const isOverdue = (task: TaskWithCustomer) =>
    parseLocalDate(task.due_date) < new Date() && OPEN_STATUSES.includes(task.status)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading tasks...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Tasks</h1>
          <p className="text-muted-foreground mt-1">
            {user?.role === 'admin'
              ? 'Manage follow-ups and to-dos across all assignees'
              : 'Manage your follow-ups and to-dos'}
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/tasks/new">
            <Plus className="mr-2 h-4 w-4" />
            New Task
          </Link>
        </Button>
      </div>

      {/* Active / Archived view */}
      <Tabs value={view} onValueChange={(v) => setView(v as 'active' | 'archived')}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                {TASK_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterPriority} onValueChange={setFilterPriority}>
              <SelectTrigger>
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priorities</SelectItem>
                <SelectItem value="1">High Priority</SelectItem>
                <SelectItem value="2">Medium Priority</SelectItem>
                <SelectItem value="3">Low Priority</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center text-sm text-muted-foreground">
              {filteredTasks.length} of {tasks.length} tasks
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tasks List */}
      <div className="space-y-4">
        {error ? (
          <ErrorState title="Unable to load tasks" message={error} onRetry={() => fetchTasks(view)} />
        ) : filteredTasks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">
                {view === 'archived' ? 'No archived tasks' : 'No tasks found'}
              </p>
              {view === 'active' && (
                <Button className="mt-4" asChild>
                  <Link href="/dashboard/tasks/new">
                    <Plus className="mr-2 h-4 w-4" />
                    Create Your First Task
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          filteredTasks.map((task) => (
            <Card key={task.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4 md:p-6">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        {getStatusIcon(task)}
                        <div>
                          <h3 className="font-semibold text-lg">{task.title}</h3>
                          {task.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {task.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-sm">
                      {task.customer && (
                        <span className="text-muted-foreground">
                          {task.customer.business_name}
                        </span>
                      )}
                      <div className="flex items-center gap-1">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span className={isOverdue(task) ? 'text-red-600 font-medium' : 'text-muted-foreground'}>
                          Due {format(parseLocalDate(task.due_date), 'MMM d, yyyy')}
                        </span>
                      </div>
                      {user && task.agent_id !== user.id && task.assignee && (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <UserIcon className="h-4 w-4" />
                          {task.assignee.name}
                        </span>
                      )}
                      {getStatusBadge(task.status)}
                      {OPEN_STATUSES.includes(task.status) && (
                        <Badge variant="outline">
                          {getPriorityLabel(task.priority)} Priority
                        </Badge>
                      )}
                    </div>
                  </div>

                  {canManageTask(task) && (
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      {view === 'active' ? (
                        <>
                          <Select
                            value={task.status}
                            onValueChange={(value) => handleStatusChange(task, value)}
                            disabled={pendingTaskId === task.id}
                          >
                            <SelectTrigger className="w-[150px]" aria-label="Change status">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TASK_STATUSES.map((status) => (
                                <SelectItem key={status} value={status}>
                                  {STATUS_LABEL[status]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openEditDialog(task)}
                            disabled={pendingTaskId === task.id}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => setArchiveTarget(task)}
                            disabled={pendingTaskId === task.id}
                          >
                            <Archive className="mr-2 h-4 w-4" />
                            Archive
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRestore(task)}
                          disabled={pendingTaskId === task.id}
                        >
                          <ArchiveRestore className="mr-2 h-4 w-4" />
                          Restore
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Edit dialog */}
      <Dialog
        open={!!editingTask}
        onOpenChange={(open) => {
          if (!open) {
            setEditingTask(null)
            setEditForm(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Task</DialogTitle>
            <DialogDescription>
              Update the task details, status, and assignee.
            </DialogDescription>
          </DialogHeader>
          {editForm && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-title">Title *</Label>
                <Input
                  id="edit-title"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <Textarea
                  id="edit-description"
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={3}
                  disabled={saving}
                  className="resize-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-due-date">Due Date *</Label>
                  <Input
                    id="edit-due-date"
                    type="date"
                    value={editForm.due_date}
                    onChange={(e) => setEditForm({ ...editForm, due_date: e.target.value })}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-status">Status *</Label>
                  <Select
                    value={editForm.status}
                    onValueChange={(value) => {
                      if (isTaskStatus(value)) setEditForm({ ...editForm, status: value })
                    }}
                  >
                    <SelectTrigger id="edit-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TASK_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {STATUS_LABEL[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-assignee">Assignee *</Label>
                <Select
                  value={editForm.agent_id}
                  onValueChange={(value) => setEditForm({ ...editForm, agent_id: value })}
                >
                  <SelectTrigger id="edit-assignee">
                    <SelectValue placeholder="Select assignee..." />
                  </SelectTrigger>
                  <SelectContent>
                    {assignees.length === 0 ? (
                      <SelectItem value={editForm.agent_id} disabled>
                        Loading users...
                      </SelectItem>
                    ) : (
                      assignees.map((assignee) => (
                        <SelectItem key={assignee.id} value={assignee.id}>
                          {assignee.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingTask(null)
                setEditForm(null)
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={saving || !editForm?.title.trim() || !editForm?.due_date}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive confirmation */}
      <AlertDialog
        open={!!archiveTarget}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this task?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget
                ? `"${archiveTarget.title}" will be moved to the Archived view. You can restore it at any time.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveConfirm}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
