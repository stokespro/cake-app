'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
import {
  Sprout,
  Clock,
  CheckCircle,
  AlertTriangle,
  CalendarDays,
  Settings,
  CheckSquare,
  MessageSquare,
  Plus,
} from 'lucide-react'
import { format, isToday, isPast, startOfWeek, endOfWeek } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import { toast } from 'sonner'
import {
  useAuth,
  canManageCultivation,
  canCompleteCultivation,
  canEndCultivationCycle,
} from '@/lib/auth-context'
import { GrowRoom, RoomCycle, CultivationTask } from '@/types/cultivation'
import { PRIORITY_BADGE } from '@/lib/cultivation/helpers'
import { TaskCompletionSheet } from '@/components/cultivation/task-completion-sheet'
import { StartCycleDialog, AdvanceStageDialog } from '@/components/cultivation/flip-room-dialog'
import { RoomHistorySheet } from '@/components/cultivation/room-history-sheet'
import { RoomCard } from '@/components/cultivation/room-card'
import {
  getGrowRooms,
  getActiveCycles,
  getCultivationTaskSummary,
  getMyTodayTasks,
  createGrowRoom,
  updateGrowRoom,
  deleteGrowRoom,
} from '@/actions/cultivation'

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskStats {
  overdue: number
  dueToday: number
  completedToday: number
  upcomingThisWeek: number
}

interface RoomTaskCounts {
  [roomId: string]: { pending: number; overdue: number }
}

// ─── Room Admin Dialog ────────────────────────────────────────────────────────

interface RoomAdminDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: GrowRoom | null // null = add mode
  onSaved: () => void
}

function RoomAdminDialog({ open, onOpenChange, room, onSaved }: RoomAdminDialogProps) {
  const [roomNumber, setRoomNumber] = useState('')
  const [roomName, setRoomName] = useState('')
  const [pairingGroup, setPairingGroup] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const isEditing = !!room

  useEffect(() => {
    if (room) {
      setRoomNumber(String(room.room_number))
      setRoomName(room.room_name)
      setPairingGroup(room.pairing_group || '')
      setNotes(room.notes || '')
    } else {
      setRoomNumber('')
      setRoomName('')
      setPairingGroup('')
      setNotes('')
    }
  }, [room, open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!roomName.trim()) {
      toast.error('Room name is required')
      return
    }
    const num = parseInt(roomNumber, 10)
    if (isNaN(num) || num < 1) {
      toast.error('Room number must be a positive number')
      return
    }

    setSaving(true)
    const payload = {
      room_number: num,
      room_name: roomName.trim(),
      pairing_group: pairingGroup.trim() || null,
      notes: notes.trim() || null,
    }

    if (isEditing) {
      const result = await updateGrowRoom(room.id, payload)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Room updated')
        onOpenChange(false)
        onSaved()
      }
    } else {
      const result = await createGrowRoom(payload)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Room added')
        onOpenChange(false)
        onSaved()
      }
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Room' : 'Add Room'}</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Update room details.' : 'Add a new grow room.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ra-number">Room Number *</Label>
              <Input
                id="ra-number"
                type="number"
                min={1}
                value={roomNumber}
                onChange={(e) => setRoomNumber(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra-name">Room Name *</Label>
              <Input
                id="ra-name"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="e.g., Flower Room 1"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ra-pairing">Pairing Group</Label>
            <Input
              id="ra-pairing"
              value={pairingGroup}
              onChange={(e) => setPairingGroup(e.target.value)}
              placeholder="e.g., A (optional)"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ra-notes">Notes</Label>
            <Textarea
              id="ra-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : isEditing ? 'Update' : 'Add Room'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CultivationPage() {
  const { user } = useAuth()
  const [rooms, setRooms] = useState<GrowRoom[]>([])
  const [activeCyclesMap, setActiveCyclesMap] = useState<Record<string, RoomCycle[]>>({})
  const [taskStats, setTaskStats] = useState<TaskStats>({
    overdue: 0,
    dueToday: 0,
    completedToday: 0,
    upcomingThisWeek: 0,
  })
  const [myTodayTasks, setMyTodayTasks] = useState<CultivationTask[]>([])
  const [roomTaskCounts, setRoomTaskCounts] = useState<RoomTaskCounts>({})
  const [loading, setLoading] = useState(true)

  // Task completion sheet
  const [completionTask, setCompletionTask] = useState<CultivationTask | null>(null)
  const [completionOpen, setCompletionOpen] = useState(false)

  // Start Cycle dialog
  const [startCycleOpen, setStartCycleOpen] = useState(false)
  const [startCycleRoom, setStartCycleRoom] = useState<GrowRoom | null>(null)

  // Advance Stage dialog
  const [advanceOpen, setAdvanceOpen] = useState(false)
  const [advanceRoom, setAdvanceRoom] = useState<GrowRoom | null>(null)

  // History sheet
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRoom, setHistoryRoom] = useState<GrowRoom | null>(null)

  // Room admin (add / edit)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminRoom, setAdminRoom] = useState<GrowRoom | null>(null)

  // Delete room confirmation
  const [deleteRoomOpen, setDeleteRoomOpen] = useState(false)
  const [deleteRoomTarget, setDeleteRoomTarget] = useState<GrowRoom | null>(null)

  const isManagement = user ? canManageCultivation(user.role) : false
  const canComplete = user ? canCompleteCultivation(user.role) : false
  const canEndCycle = user ? canEndCultivationCycle(user.role) : false

  // ─── Data fetching ──────────────────────────────────────────────────────────

  const fetchRooms = useCallback(async () => {
    const [roomsRes, cyclesRes] = await Promise.all([
      getGrowRooms(),
      getActiveCycles(),
    ])
    if (roomsRes.data) setRooms(roomsRes.data)
    if (cyclesRes.data) {
      const map: Record<string, RoomCycle[]> = {}
      for (const cycle of cyclesRes.data) {
        if (!map[cycle.room_id]) map[cycle.room_id] = []
        map[cycle.room_id].push(cycle)
      }
      setActiveCyclesMap(map)
    }
  }, [])

  async function fetchData() {
    try {
    // Recurring task generation now runs on a nightly Vercel Cron
    // (app/api/cron/generate-recurring-tasks/route.ts) instead of on every
    // page load — see generateRecurringTasksCore in actions/cultivation.ts.
    const todayStr = format(new Date(), 'yyyy-MM-dd')
    const [roomsRes, cyclesRes, tasksRes, myTasksRes] = await Promise.all([
      getGrowRooms(),
      getActiveCycles(),
      getCultivationTaskSummary(),
      // userId is now derived server-side from the session — no client-passed id
      user ? getMyTodayTasks(todayStr) : Promise.resolve({ data: [] }),
    ])

    if (roomsRes.data) setRooms(roomsRes.data)

    if (cyclesRes.data) {
      const map: Record<string, RoomCycle[]> = {}
      for (const cycle of cyclesRes.data) {
        if (!map[cycle.room_id]) map[cycle.room_id] = []
        map[cycle.room_id].push(cycle)
      }
      setActiveCyclesMap(map)
    }

    if (myTasksRes.data) setMyTodayTasks(myTasksRes.data as CultivationTask[])

    if (tasksRes.data) {
      const today = new Date()
      const todayStr = format(today, 'yyyy-MM-dd')
      const weekStart = startOfWeek(today, { weekStartsOn: 1 })
      const weekEnd = endOfWeek(today, { weekStartsOn: 1 })

      let overdue = 0
      let dueToday = 0
      let completedToday = 0
      let upcomingThisWeek = 0
      const counts: RoomTaskCounts = {}

      for (const task of tasksRes.data) {
        const dueDate = parseLocalDate(task.due_date)
        const isActive = task.status === 'pending' || task.status === 'in_progress'
        const isTaskOverdue = isActive && task.due_date < todayStr

        if (task.status === 'completed' && task.completed_at && isToday(new Date(task.completed_at))) {
          completedToday++
        }
        if (isActive && isPast(dueDate) && task.due_date < todayStr) overdue++
        if (isActive && task.due_date === todayStr) dueToday++
        if (isActive && dueDate >= weekStart && dueDate <= weekEnd && task.due_date > todayStr) {
          upcomingThisWeek++
        }

        if (task.room_id && isActive) {
          if (!counts[task.room_id]) counts[task.room_id] = { pending: 0, overdue: 0 }
          counts[task.room_id].pending++
          if (isTaskOverdue) counts[task.room_id].overdue++
        }
      }

      setTaskStats({ overdue, dueToday, completedToday, upcomingThisWeek })
      setRoomTaskCounts(counts)
    }
    } catch (err) {
      console.error('[cultivation] fetchData error:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Room action handlers ───────────────────────────────────────────────────

  function handleStartCycle(room: GrowRoom) {
    setStartCycleRoom(room)
    setStartCycleOpen(true)
  }

  function handleAdvanceStage(room: GrowRoom) {
    setAdvanceRoom(room)
    setAdvanceOpen(true)
  }

  function handleHistory(room: GrowRoom) {
    setHistoryRoom(room)
    setHistoryOpen(true)
  }

  function handleAddRoom() {
    setAdminRoom(null)
    setAdminOpen(true)
  }

  function handleEditRoom(room: GrowRoom) {
    setAdminRoom(room)
    setAdminOpen(true)
  }

  function handleDeleteRoom(room: GrowRoom) {
    setDeleteRoomTarget(room)
    setDeleteRoomOpen(true)
  }

  async function confirmDeleteRoom() {
    if (!deleteRoomTarget) return
    const roomCycles = activeCyclesMap[deleteRoomTarget.id]
    if (roomCycles && roomCycles.length > 0) {
      toast.error('Cannot remove a room with active cycles')
      setDeleteRoomOpen(false)
      setDeleteRoomTarget(null)
      return
    }
    const result = await deleteGrowRoom(deleteRoomTarget.id)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Room removed')
      fetchRooms()
    }
    setDeleteRoomOpen(false)
    setDeleteRoomTarget(null)
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading cultivation data...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sprout className="h-6 w-6" />
            Cultivation
          </h1>
          <p className="text-muted-foreground">
            Grow room management and task tracking
          </p>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            <span>Slack bot active in #grow channel</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/cultivation/tasks">
            <Button variant="outline">
              <CheckSquare className="h-4 w-4 mr-2" />
              View Tasks
            </Button>
          </Link>
          {isManagement && (
            <>
              <Button variant="outline" onClick={handleAddRoom}>
                <Plus className="h-4 w-4 mr-2" />
                Add Room
              </Button>
              <Link href="/dashboard/cultivation/templates">
                <Button variant="outline">
                  <Settings className="h-4 w-4 mr-2" />
                  Manage Templates
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Task Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Overdue Tasks</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${taskStats.overdue > 0 ? 'text-red-600' : ''}`}>
              {taskStats.overdue}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Due Today</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{taskStats.dueToday}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Completed Today</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{taskStats.completedToday}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Upcoming This Week</CardTitle>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{taskStats.upcomingThisWeek}</div>
          </CardContent>
        </Card>
      </div>

      {/* My Tasks Today */}
      {myTodayTasks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Your Tasks Today</CardTitle>
              <Link href="/dashboard/cultivation/tasks">
                <Button variant="link" size="sm" className="text-xs px-0">
                  View All
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {myTodayTasks.map((task) => {
                const todayStr = format(new Date(), 'yyyy-MM-dd')
                const taskOverdue = task.due_date < todayStr
                return (
                  <div
                    key={task.id}
                    className={`flex items-center gap-3 p-2 rounded-md border ${taskOverdue ? 'border-red-500/50 bg-red-500/5' : 'border-border'}`}
                  >
                    {canComplete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        title="Mark complete"
                        onClick={() => {
                          setCompletionTask(task)
                          setCompletionOpen(true)
                        }}
                      >
                        <CheckCircle className="h-4 w-4 text-muted-foreground hover:text-green-500" />
                      </Button>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {task.room?.room_name && <span>{task.room.room_name}</span>}
                        {taskOverdue && (
                          <span className="text-red-600 font-medium">Overdue</span>
                        )}
                      </div>
                    </div>
                    <Badge className={`${PRIORITY_BADGE[task.priority]} shrink-0 text-[10px] px-1.5`}>
                      {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                    </Badge>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grow Rooms Grid */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Grow Rooms</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rooms.map((room) => {
            const roomCycles = activeCyclesMap[room.id] || []
            const roomCounts = roomTaskCounts[room.id]

            return (
              <RoomCard
                key={room.id}
                room={room}
                activeCycles={roomCycles}
                allRooms={rooms}
                taskCounts={roomCounts}
                onStartCycle={isManagement ? handleStartCycle : undefined}
                onAdvanceStage={isManagement ? handleAdvanceStage : undefined}
                onHistory={handleHistory}
                onEdit={isManagement ? handleEditRoom : undefined}
                onDelete={isManagement ? handleDeleteRoom : undefined}
              />
            )
          })}
        </div>
      </div>

      {/* Task Completion Sheet */}
      <TaskCompletionSheet
        open={completionOpen}
        onOpenChange={setCompletionOpen}
        task={completionTask}
        userId={user?.id || ''}
        onCompleted={() => {
          setCompletionOpen(false)
          fetchData()
        }}
      />

      {/* Start Cycle Dialog */}
      {user && (
        <StartCycleDialog
          open={startCycleOpen}
          onOpenChange={setStartCycleOpen}
          room={startCycleRoom}
          userId={user.id}
          onCompleted={fetchRooms}
        />
      )}

      {/* Advance Stage Dialog */}
      {advanceRoom && (
        <AdvanceStageDialog
          open={advanceOpen}
          onOpenChange={setAdvanceOpen}
          room={advanceRoom}
          activeCycles={activeCyclesMap[advanceRoom.id] || []}
          onCompleted={fetchRooms}
          canEndCycle={canEndCycle}
        />
      )}

      {/* History Sheet */}
      <RoomHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        room={historyRoom}
      />

      {/* Room Admin Dialog (Add / Edit) */}
      <RoomAdminDialog
        open={adminOpen}
        onOpenChange={setAdminOpen}
        room={adminRoom}
        onSaved={fetchRooms}
      />

      {/* Delete Room Confirmation */}
      <AlertDialog open={deleteRoomOpen} onOpenChange={setDeleteRoomOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Room</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{deleteRoomTarget?.room_name}&quot;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteRoom}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
