import { ToolResult } from './types'
import { resolveSwitcherAdvance } from '@/lib/cultivation/helpers'
import { PHASE_CONFIG, type PipelineStage } from '@/types/cultivation'

export async function queryTasks(supabase: any, params: {
  assigned_to?: string
  room_number?: number
  status?: string
  overdue_only?: boolean
  due_today?: boolean
  limit?: number
}): Promise<ToolResult> {
  try {
    let query = supabase
      .from('cultivation_tasks')
      .select('*, room:grow_rooms(room_name, room_number), assigned_user:users!cultivation_tasks_assigned_to_fkey(name)')
      .or('frequency.is.null,recurring_parent_id.not.is.null') // Exclude recurring definitions

    if (params.assigned_to) {
      query = query.eq('assigned_to', params.assigned_to)
    }
    if (params.room_number) {
      // Need to get room_id from room_number
      const { data: room } = await supabase
        .from('grow_rooms')
        .select('id')
        .eq('room_number', params.room_number)
        .single()
      if (room) query = query.eq('room_id', room.id)
    }
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.overdue_only) {
      const today = new Date().toISOString().split('T')[0]
      query = query.lt('due_date', today).in('status', ['pending', 'in_progress'])
    }
    if (params.due_today) {
      const today = new Date().toISOString().split('T')[0]
      query = query.eq('due_date', today).in('status', ['pending', 'in_progress'])
    }

    query = query.order('due_date').limit(params.limit || 20)

    const { data, error } = await query
    if (error) throw error

    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Hard refusal path — NOT an LLM "please confirm" turn. Phase-switcher
 * tasks change room_cycles.current_stage (and grow_rooms.current_phase) as
 * a side effect of completion (see migration
 * 20260812120000_add_phase_switcher.sql and completeTask in
 * actions/cultivation.ts) — that's a state change no agent (Bud, or any
 * future Slack/LLM caller) is allowed to make unsupervised, only a human
 * confirming it in the app. This runs in plain code before any DB write and
 * returns a refusal string, or null when completion is fine to proceed;
 * there is no code path here the model can talk its way around by
 * rephrasing, retrying, or being asked nicely — it is not a prompt-level
 * instruction, it's a return value the caller is hard-wired to obey.
 *
 * Shared by both completeTask (the dedicated completion tool) and editTask
 * (which can also set status: 'completed' — without this same check there
 * that would be a second, unguarded path to exactly the write this
 * function exists to block).
 */
async function refusalIfSwitcherWouldAdvance(supabase: any, taskId: string): Promise<string | null> {
  const { data: task, error: taskErr } = await supabase
    .from('cultivation_tasks')
    .select('id, title, is_phase_switcher, phase, room_cycle_id, room:grow_rooms(room_name)')
    .eq('id', taskId)
    .maybeSingle()

  if (taskErr) throw taskErr
  if (!task?.is_phase_switcher || !task.phase || !task.room_cycle_id) return null

  const { data: cycle, error: cycleErr } = await supabase
    .from('room_cycles')
    .select('current_stage, cycle_number, status')
    .eq('id', task.room_cycle_id)
    .maybeSingle()

  if (cycleErr) throw cycleErr
  if (cycle?.status !== 'active') return null

  const advancesTo = resolveSwitcherAdvance(cycle.current_stage, task.phase)
  if (!advancesTo) return null

  const roomLabel = task.room?.room_name ? `${task.room.room_name} ` : ''
  const cycleLabel = cycle.cycle_number != null ? `Cycle ${cycle.cycle_number} ` : ''
  const stageLabel = PHASE_CONFIG[advancesTo as PipelineStage]?.label ?? advancesTo
  return `"${task.title}" advances ${roomLabel}${cycleLabel}to ${stageLabel}. Please complete it in the app so the change is confirmed.`
}

export async function completeTask(supabase: any, params: {
  task_id: string
  notes?: string
  completed_by: string
}): Promise<ToolResult> {
  try {
    const refusal = await refusalIfSwitcherWouldAdvance(supabase, params.task_id)
    if (refusal) return { success: false, error: refusal }

    const { data, error } = await supabase
      .from('cultivation_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_by: params.completed_by,
        completion_notes: params.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.task_id)
      .select('title, room:grow_rooms(room_name)')
      .single()

    if (error) throw error
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function createTask(supabase: any, params: {
  title: string
  description?: string
  room_number?: number
  assigned_to?: string
  due_date: string
  priority?: string
  created_by: string
}): Promise<ToolResult> {
  try {
    let roomId = null
    if (params.room_number) {
      const { data: room } = await supabase
        .from('grow_rooms')
        .select('id')
        .eq('room_number', params.room_number)
        .single()
      roomId = room?.id
    }

    const { data, error } = await supabase
      .from('cultivation_tasks')
      .insert({
        title: params.title,
        description: params.description || null,
        room_id: roomId,
        assigned_to: params.assigned_to || null,
        due_date: params.due_date,
        priority: params.priority || 'medium',
        task_type: 'adhoc',
        status: 'pending',
        created_by: params.created_by,
      })
      .select('title')
      .single()

    if (error) throw error
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function editTask(supabase: any, params: {
  task_id: string
  assigned_to?: string
  priority?: string
  due_date?: string
  status?: string
}): Promise<ToolResult> {
  try {
    // editTask can also drive status to 'completed' — without this same
    // refusal check, it would be a second, unguarded path around
    // completeTask's phase-switcher guard above.
    if (params.status === 'completed') {
      const refusal = await refusalIfSwitcherWouldAdvance(supabase, params.task_id)
      if (refusal) return { success: false, error: refusal }
    }

    const updates: any = { updated_at: new Date().toISOString() }
    if (params.assigned_to !== undefined) updates.assigned_to = params.assigned_to
    if (params.priority) updates.priority = params.priority
    if (params.due_date) updates.due_date = params.due_date
    if (params.status) updates.status = params.status

    const { data, error } = await supabase
      .from('cultivation_tasks')
      .update(updates)
      .eq('id', params.task_id)
      .select('title')
      .single()

    if (error) throw error
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getRoomStatus(supabase: any, params: {
  room_number?: number
}): Promise<ToolResult> {
  try {
    let query = supabase
      .from('grow_rooms')
      .select('*')
      .order('room_number')

    if (params.room_number) {
      query = query.eq('room_number', params.room_number)
    }

    const { data: rooms, error } = await query
    if (error) throw error

    // Get task counts per room
    for (const room of rooms) {
      const today = new Date().toISOString().split('T')[0]
      const { count: pendingCount } = await supabase
        .from('cultivation_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', room.id)
        .in('status', ['pending', 'in_progress'])

      const { count: overdueCount } = await supabase
        .from('cultivation_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', room.id)
        .in('status', ['pending', 'in_progress'])
        .lt('due_date', today)

      room.pending_tasks = pendingCount || 0
      room.overdue_tasks = overdueCount || 0

      // Compute current week
      if (room.phase_start_date && room.current_phase !== 'empty') {
        const start = new Date(room.phase_start_date + 'T00:00:00')
        const now = new Date()
        room.current_week = Math.floor((now.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
      }
    }

    return { success: true, data: rooms }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getUserByName(supabase: any, params: {
  name: string
}): Promise<ToolResult> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, role')
      .ilike('name', `%${params.name}%`)

    if (error) throw error
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
