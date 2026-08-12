'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { getCultivationTasksForDisplay, completeTask } from '@/actions/cultivation'
import { getCurrentSession } from '@/actions/auth'
import { canCompleteCultivation, type UserRole } from '@/lib/auth-context'
import { getSwitcherAdvancePreview } from '@/lib/cultivation/helpers'
import { CheckCircle } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { PHASE_CONFIG } from '@/types/cultivation'
import type { CultivationTask, PipelineStage } from '@/types/cultivation'

function phaseLabel(stage: string): string {
  return PHASE_CONFIG[stage as PipelineStage]?.label ?? stage
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 60_000

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTodayStr(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

function groupByRoom(tasks: CultivationTask[]): Array<{ roomName: string; tasks: CultivationTask[] }> {
  const map = new Map<string | null, CultivationTask[]>()

  for (const task of tasks) {
    const key = task.room_id ?? null
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(task)
  }

  const groups: Array<{ roomName: string; tasks: CultivationTask[] }> = []

  // Named room groups first (sorted by room name)
  const namedEntries = Array.from(map.entries()).filter(([key]) => key !== null)
  namedEntries.sort((a, b) => {
    const roomA = a[1][0]?.room?.room_name ?? ''
    const roomB = b[1][0]?.room?.room_name ?? ''
    return roomA.localeCompare(roomB)
  })
  for (const [, tasks] of namedEntries) {
    const roomName = tasks[0]?.room?.room_name ?? 'Unknown Room'
    groups.push({ roomName, tasks })
  }

  // General (null room_id) last
  if (map.has(null)) {
    groups.push({ roomName: 'General', tasks: map.get(null)! })
  }

  return groups
}

/**
 * First-name-only, comma-joined assignee label for the narrow, single-line
 * "Assigned To" column on the wall-monitor display. Falls back to the
 * legacy single assignee for pre-migration tasks. Truncates to 2 names with
 * a "+N" suffix to keep the column readable at a glance on a TV.
 */
function assigneeDisplayLabel(task: CultivationTask): string {
  const names =
    task.assignees && task.assignees.length > 0
      ? task.assignees.map((a) => a.name.split(' ')[0])
      : task.assigned_user
        ? [task.assigned_user.name.split(' ')[0]]
        : []

  if (names.length === 0) return 'Unassigned'
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

function phaseDayLabel(task: CultivationTask): string {
  if (task.phase && task.day_number != null) {
    const label =
      PHASE_CONFIG[task.phase as PipelineStage]?.label ??
      task.phase.charAt(0).toUpperCase() + task.phase.slice(1)
    return `${label} · Day ${task.day_number}`
  }
  if (task.phase) {
    const label =
      PHASE_CONFIG[task.phase as PipelineStage]?.label ??
      task.phase.charAt(0).toUpperCase() + task.phase.slice(1)
    return label
  }
  if (task.day_number != null) {
    return `Day ${task.day_number}`
  }
  return '—'
}

// ─── Task Row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: CultivationTask
  onRequestComplete: (task: CultivationTask) => void
  isOverdue: boolean
  canComplete: boolean
}

function TaskRow({ task, onRequestComplete, isOverdue, canComplete }: TaskRowProps) {
  return (
    <TableRow
      className={`${isOverdue ? 'border-l-2 border-l-red-500' : ''} h-9`}
    >
      {/* Title — truncates with ellipsis via table-fixed layout */}
      <TableCell className="px-1 py-1 overflow-hidden">
        <span className="block truncate text-lg font-medium leading-snug" title={task.title}>
          {task.title}
        </span>
      </TableCell>

      {/* Phase / Day */}
      <TableCell className="px-1 py-1 text-base text-zinc-300 whitespace-nowrap">
        {phaseDayLabel(task)}
      </TableCell>

      {/* Assigned To — comma-joined first names, "+N" fallback for 3+ */}
      <TableCell className="px-1 py-1 text-base text-zinc-400 whitespace-nowrap overflow-hidden">
        <span className="block truncate" title={
          task.assignees && task.assignees.length > 0
            ? task.assignees.map((a) => a.name).join(', ')
            : task.assigned_user?.name ?? 'Unassigned'
        }>
          {assigneeDisplayLabel(task)}
        </span>
      </TableCell>

      {/* Complete icon button — opens confirmation dialog.
          Only rendered for roles that can actually complete cultivation tasks
          server-side — otherwise a tap would optimistically hide the row and
          then flicker back once the server rejects the completion. */}
      <TableCell className="px-1 py-1 text-center">
        {canComplete && (
          <button
            onClick={() => onRequestComplete(task)}
            aria-label="Mark complete"
            className="inline-flex items-center justify-center text-zinc-400 hover:text-green-400 transition-colors"
          >
            <CheckCircle className="h-6 w-6" />
          </button>
        )}
      </TableCell>
    </TableRow>
  )
}

// ─── Room Group Table ─────────────────────────────────────────────────────────

interface RoomGroupTableProps {
  group: { roomName: string; tasks: CultivationTask[] }
  completedIds: Set<string>
  onRequestComplete: (task: CultivationTask) => void
  isOverdue: boolean
  canComplete: boolean
}

function RoomGroupTable({ group, completedIds, onRequestComplete, isOverdue, canComplete }: RoomGroupTableProps) {
  const visibleTasks = group.tasks.filter((t) => !completedIds.has(t.id))
  if (visibleTasks.length === 0) return null

  return (
    <div className="mb-4">
      <h3 className="text-xl font-semibold text-zinc-300 border-b border-zinc-700 pb-1 mb-1">
        {group.roomName}
      </h3>
      <div className="w-full overflow-x-hidden">
        <Table className="table-fixed w-full">
          <colgroup>
            <col style={{ width: '50%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '8%' }} />
          </colgroup>
          <TableHeader>
            <TableRow className="border-zinc-700 hover:bg-transparent">
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500 px-1 py-1 h-7">Title</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500 px-1 py-1 h-7 whitespace-nowrap">Phase / Day</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500 px-1 py-1 h-7 whitespace-nowrap">Assigned To</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500 px-1 py-1 h-7 text-center">Done</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onRequestComplete={onRequestComplete}
                isOverdue={isOverdue}
                canComplete={canComplete}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ─── Column ───────────────────────────────────────────────────────────────────

interface ColumnProps {
  title: string
  count: number
  headingClass: string
  groups: Array<{ roomName: string; tasks: CultivationTask[] }>
  emptyMessage: string
  emptyClass: string
  completedIds: Set<string>
  onRequestComplete: (task: CultivationTask) => void
  isOverdue: boolean
  canComplete: boolean
}

function TaskColumn({
  title,
  count,
  headingClass,
  groups,
  emptyMessage,
  emptyClass,
  completedIds,
  onRequestComplete,
  isOverdue,
  canComplete,
}: ColumnProps) {
  const allTaskCount = groups.reduce((n, g) => {
    return n + g.tasks.filter((t) => !completedIds.has(t.id)).length
  }, 0)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Column heading */}
      <div className={`rounded-lg border px-5 py-3 mb-4 ${headingClass}`}>
        <h2 className="text-2xl font-bold tracking-tight">
          {title} ({count})
        </h2>
      </div>

      {/* Scrollable task list */}
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pr-1">
        {allTaskCount === 0 ? (
          <p className={`text-lg ${emptyClass}`}>{emptyMessage}</p>
        ) : (
          groups.map((group) => (
            <RoomGroupTable
              key={group.roomName}
              group={group}
              completedIds={completedIds}
              onRequestComplete={onRequestComplete}
              isOverdue={isOverdue}
              canComplete={canComplete}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CultivationTasksDisplayPage() {
  const router = useRouter()
  const [overdueTasks, setOverdueTasks] = useState<CultivationTask[]>([])
  const [todayTasks, setTodayTasks] = useState<CultivationTask[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [userId, setUserId] = useState<string>('')
  const [userRole, setUserRole] = useState<UserRole | ''>('')
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const [confirmTask, setConfirmTask] = useState<CultivationTask | null>(null)
  const [confirming, setConfirming] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // UX-only auth redirect — display pages are read-only; gate with localStorage
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('crm-user') : null
    if (!stored) {
      router.replace('/login?next=/cultivation-display/tasks')
      return
    }
    try {
      const parsed = JSON.parse(stored)
      setUserId(parsed.id ?? '')
      setUserRole(parsed.role ?? '')
    } catch {
      // malformed — ignore; canComplete defaults to false (fail closed) and
      // completeTask will also fail server-side if somehow reached
    }
  }, [router])

  // Reconcile the cached role against the server. localStorage['crm-user'] is
  // only ever written at PIN-login time — if an admin changes this user's
  // role in the DB while they're still logged in (the normal case for a
  // kiosk/wall-display tab left running for days), the cached role goes
  // stale and canComplete below would keep evaluating against the OLD role
  // forever, hiding the Mark Complete button even after the role gains
  // permission. Re-check on mount and on every scheduled poll tick (below)
  // so a long-running kiosk tab self-heals within one refresh cycle instead
  // of requiring a manual log-out/log-in.
  const syncSession = useCallback(async () => {
    try {
      const fresh = await getCurrentSession()
      if (!fresh) return // no valid session cookie — fail soft, keep cached user as-is
      setUserId((prev) => (prev !== fresh.id ? fresh.id : prev))
      setUserRole((prev) => (prev !== fresh.role ? (fresh.role as UserRole) : prev))
      try {
        const stored = localStorage.getItem('crm-user')
        const parsed = stored ? JSON.parse(stored) : {}
        if (parsed.role !== fresh.role || parsed.id !== fresh.id || parsed.name !== fresh.name) {
          localStorage.setItem(
            'crm-user',
            JSON.stringify({ id: fresh.id, name: fresh.name, role: fresh.role })
          )
        }
      } catch {
        // malformed existing value — overwrite with the known-good server copy
        localStorage.setItem(
          'crm-user',
          JSON.stringify({ id: fresh.id, name: fresh.name, role: fresh.role })
        )
      }
    } catch (err) {
      console.error('[cultivation-display/tasks] session sync failed:', err)
    }
  }, [])

  useEffect(() => {
    syncSession()
  }, [syncSession])

  // Fail-closed default: no role loaded yet (or malformed) means no complete button
  const canComplete = userRole ? canCompleteCultivation(userRole) : false

  const fetchTasks = useCallback(async () => {
    try {
      const todayStr = getTodayStr()
      const result = await getCultivationTasksForDisplay(todayStr)
      if (result.data) {
        const tasks = result.data as CultivationTask[]
        setOverdueTasks(tasks.filter((t) => t.due_date < todayStr))
        setTodayTasks(tasks.filter((t) => t.due_date === todayStr))
        setLastUpdated(new Date())
        // Clear optimistic completions — server is now source of truth
        setCompletedIds(new Set())
      }
    } catch (err) {
      console.error('[cultivation-display/tasks] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  // Auto-refresh via chained setTimeout (mirrors packaging board pattern).
  // Session sync rides along on the same cadence so a kiosk tab left running
  // for days picks up role changes without needing a manual reload.
  useEffect(() => {
    function schedule() {
      refreshTimerRef.current = setTimeout(() => {
        Promise.all([fetchTasks(), syncSession()]).then(schedule)
      }, REFRESH_INTERVAL)
    }
    schedule()
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [fetchTasks, syncSession])

  // Listen for revert events (action failure) — trigger immediate refetch
  useEffect(() => {
    function handleRevert() {
      fetchTasks()
    }
    window.addEventListener('cultivation-task-revert', handleRevert)
    return () => window.removeEventListener('cultivation-task-revert', handleRevert)
  }, [fetchTasks])

  function handleCompleted(taskId: string) {
    setCompletedIds((prev) => {
      const next = new Set(prev)
      next.add(taskId)
      return next
    })
  }

  function handleRequestComplete(task: CultivationTask) {
    setConfirmTask(task)
  }

  async function handleConfirmComplete() {
    if (!confirmTask || confirming) return
    setConfirming(true)
    const taskTitle = confirmTask.title
    // Optimistic removal
    handleCompleted(confirmTask.id)
    setConfirmTask(null)
    try {
      const result = await completeTask({
        taskId: confirmTask.id,
        completedBy: userId,
        notes: null,
      })
      if ('error' in result) {
        toast.error(`Could not complete "${taskTitle}" — it will reappear on the board. (${result.error})`, {
          duration: 8000,
        })
        window.dispatchEvent(new CustomEvent('cultivation-task-revert'))
      } else if (result.advancedTo) {
        toast.success(`Task completed. Advanced to ${phaseLabel(result.advancedTo)}.`)
      }
    } catch (err) {
      // Thrown/rejected promise (network error, stale deployment, etc.) — treat
      // the same as a returned error so the optimistic hide always gets reverted
      // and `confirming` never gets stuck true.
      console.error('[cultivation-display/tasks] completeTask threw:', err)
      toast.error(`Could not complete "${taskTitle}" — connection or server error. It will reappear on the board.`, {
        duration: 8000,
      })
      window.dispatchEvent(new CustomEvent('cultivation-task-revert'))
    } finally {
      setConfirming(false)
    }
  }

  const overdueGroups = groupByRoom(overdueTasks)
  const todayGroups = groupByRoom(todayTasks)

  // Single shared "does this need confirming?" check (see
  // getSwitcherAdvancePreview in lib/cultivation/helpers.ts) — also drives
  // TaskCompletionSheet's confirm step. On this touch-operated wall
  // monitor, the warning is folded into the existing tap-to-complete
  // confirmation dialog (below) rather than a second dialog, so it can't
  // get lost behind an extra tap.
  const confirmAdvanceTo = confirmTask ? getSwitcherAdvancePreview(confirmTask) : null
  const confirmAdvanceLabel = confirmAdvanceTo ? phaseLabel(confirmAdvanceTo) : null

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center text-zinc-400 text-lg">
        Loading tasks...
      </div>
    )
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col text-lg">
      {/* Page header */}
      <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">
          Cultivation Tasks
        </h1>
        <span className="text-base text-zinc-500">
          {format(new Date(), 'EEEE, MMMM d')}
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-6 px-6 pb-12">
        <TaskColumn
          title="Overdue"
          count={overdueTasks.length}
          headingClass="bg-red-900/40 border-red-600"
          groups={overdueGroups}
          emptyMessage="No overdue tasks"
          emptyClass="text-green-400"
          completedIds={completedIds}
          onRequestComplete={handleRequestComplete}
          isOverdue={true}
          canComplete={canComplete}
        />
        <TaskColumn
          title="Today"
          count={todayTasks.length}
          headingClass="bg-amber-900/40 border-amber-500"
          groups={todayGroups}
          emptyMessage="All caught up for today"
          emptyClass="text-zinc-400"
          completedIds={completedIds}
          onRequestComplete={handleRequestComplete}
          isOverdue={false}
          canComplete={canComplete}
        />
      </div>

      {/* Last updated footer */}
      {lastUpdated && (
        <div className="fixed bottom-4 right-6 text-base text-zinc-500">
          Updated {format(lastUpdated, 'h:mm a')}
        </div>
      )}

      {/* Confirmation dialog — prevents accidental mis-taps on wall monitor.
          When the task is a phase switcher that would actually advance the
          cycle, that warning is folded in here (not a second dialog) so it
          can't get missed on a touch-operated board. */}
      <AlertDialog open={confirmTask !== null} onOpenChange={(open) => { if (!open) setConfirmTask(null) }}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-2xl font-bold">
              Mark task complete?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-lg mt-1">
              Mark &ldquo;{confirmTask?.title}&rdquo; as complete?
              {confirmTask?.room?.room_name ? ` (${confirmTask.room.room_name})` : ''}
              {' '}This removes it from the board.
            </AlertDialogDescription>
            {confirmAdvanceLabel && (
              <p className="text-lg font-bold text-amber-400 mt-3 border-t border-zinc-700 pt-3">
                By completing this task you are also advancing this cycle to {confirmAdvanceLabel}.
                Please confirm.
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-base">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="text-base bg-green-700 hover:bg-green-600"
              onClick={handleConfirmComplete}
            >
              Mark Complete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
