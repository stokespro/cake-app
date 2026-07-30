'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { generateRecurringTasksCore } from '@/lib/cultivation/generate-recurring-tasks'
import type {
  GrowRoom,
  RoomCycle,
  CycleTemplate,
  TemplateTask,
  TaskPriority,
  TemplateType,
  CultivationTaskStatus,
} from '@/types/cultivation'

// ---------------------------------------------------------------------------
// Role sets
// ---------------------------------------------------------------------------

// All roles that can view cultivation (mirrors canViewSection('cultivation'))
const VIEW_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard', 'grow']

// Roles that can complete/start tasks (mirrors canCompleteCultivation)
const COMPLETE_ROLES = ['admin', 'management', 'vault', 'packaging', 'grow']

// Roles that can manage (create/edit/delete) cultivation data (mirrors canManageCultivation)
const MANAGE_ROLES = ['admin', 'management']

// ---------------------------------------------------------------------------
// Grow Rooms — reads
// ---------------------------------------------------------------------------

export async function getGrowRooms(): Promise<
  { data: GrowRoom[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('grow_rooms')
    .select('*')
    .order('room_number')

  if (error) {
    console.error('[cultivation] getGrowRooms error:', error)
    return { error: 'Failed to load grow rooms' }
  }
  return { data: data as GrowRoom[] }
}

// ---------------------------------------------------------------------------
// Room Cycles — reads
// ---------------------------------------------------------------------------

export async function getActiveCycles(): Promise<
  { data: RoomCycle[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('room_cycles')
    .select('*')
    .eq('status', 'active')

  if (error) {
    console.error('[cultivation] getActiveCycles error:', error)
    return { error: 'Failed to load active cycles' }
  }
  return { data: data as RoomCycle[] }
}

export async function getRoomCycleHistory(roomId: string): Promise<
  { data: unknown[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('room_cycles')
    .select('*, template:cycle_templates(name), tasks:cultivation_tasks(id, status)')
    .eq('room_id', roomId)
    .order('start_date', { ascending: false })

  if (error) {
    console.error('[cultivation] getRoomCycleHistory error:', error)
    return { error: 'Failed to load cycle history' }
  }
  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Cultivation Tasks — reads
// ---------------------------------------------------------------------------

// Embed used to pull the full multi-assignee list onto a cultivation_tasks row.
// FK hint disambiguates against cultivation_task_assignees_assigned_by_fkey,
// which also targets users.
const ASSIGNEES_EMBED =
  'assignees:cultivation_task_assignees(user:users!cultivation_task_assignees_user_id_fkey(id, name))'

interface AssigneesEmbedRow {
  assignees?: { user: { id: string; name: string } | null }[] | null
}

/**
 * Flatten the `{ user: {...} }[]` shape PostgREST returns for the
 * cultivation_task_assignees embed into a plain `{ id, name }[]` on
 * `assignees`, for easier consumption in the UI.
 */
function flattenAssignees<T extends AssigneesEmbedRow>(
  rows: T[]
): (T & { assignees: { id: string; name: string }[] })[] {
  return rows.map((row) => ({
    ...row,
    assignees: (row.assignees ?? [])
      .map((a) => a.user)
      .filter((u): u is { id: string; name: string } => u != null),
  }))
}

// Statuses treated as "incomplete" — this is what loads by default, and
// what backs the "Past Due & Today" preset. Completed/skipped rows are only
// ever fetched when explicitly requested via the Status filter, scoped to a
// window, so we don't drag the ever-growing history of finished tasks down
// on every page load.
const DEFAULT_STATUSES: CultivationTaskStatus[] = ['pending', 'in_progress']

// Statuses that represent finished (history) rows. These accumulate forever,
// so any query that includes one of them gets a hard lower bound on
// due_date — see HISTORY_LOOKBACK_DAYS below — even if the caller asked for
// an unbounded start (e.g. the "Past Due & Today" preset, which passes
// dateFrom: null so pending/in_progress overdue tasks always show).
const HISTORY_STATUSES: CultivationTaskStatus[] = ['completed', 'skipped']

// Max number of days back we'll ever query for completed/skipped tasks,
// regardless of the requested dateFrom. Prevents an unbounded "Past Due &
// Today" + Status=Completed combo (or any other unbounded-start query that
// includes a history status) from scanning the entire all-time history
// table. Tune here if the business needs a longer lookback.
const HISTORY_LOOKBACK_DAYS = 30

// Default page size for server-side pagination when the caller doesn't
// specify one.
const DEFAULT_PAGE_SIZE = 50

export interface GetCultivationTasksParams {
  /**
   * Lower bound (inclusive) on due_date, as a YYYY-MM-DD string. Omit or
   * pass null/undefined for an unbounded start — this is what makes
   * "Past Due & Today" (and the bare default call) always surface overdue
   * tasks regardless of how far in the past they're due. Note: if `statuses`
   * includes a history status (completed/skipped), the effective start is
   * still capped at HISTORY_LOOKBACK_DAYS back — see below.
   */
  dateFrom?: string | null
  /**
   * Upper bound (inclusive) on due_date, as a YYYY-MM-DD string. Undefined
   * defaults to today (matching the bare default call / "Past Due & Today").
   * Pass null explicitly for an unbounded end (e.g. a Custom range with no
   * "To" date entered).
   */
  dateTo?: string | null
  /** Defaults to incomplete tasks only (pending, in_progress). */
  statuses?: CultivationTaskStatus[]
  /** Max rows to return. Defaults to DEFAULT_PAGE_SIZE (50). */
  limit?: number
  /** Row offset for pagination. Defaults to 0. */
  offset?: number
}

export interface GetCultivationTasksResult {
  tasks: unknown[]
  /** Total rows matching the filters (ignoring limit/offset). */
  totalCount: number
  /** Whether more rows exist beyond this page (offset + tasks.length < totalCount). */
  hasMore: boolean
}

export async function getCultivationTasks(
  params: GetCultivationTasksParams = {}
): Promise<{ data: GetCultivationTasksResult; error?: never } | { data?: never; error: string }> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const statuses = params.statuses ?? DEFAULT_STATUSES
  let dateFrom = params.dateFrom ?? null
  const dateTo = params.dateTo === undefined ? new Date().toISOString().split('T')[0] : params.dateTo
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_PAGE_SIZE
  const offset = params.offset && params.offset > 0 ? params.offset : 0

  // Never let a query that includes completed/skipped rows look back further
  // than HISTORY_LOOKBACK_DAYS, even if the caller passed an unbounded (or
  // further-back) dateFrom — completed/skipped history only ever grows, so
  // an unbounded start here would re-fetch the entire all-time table (the
  // exact slow-load regression this cap exists to prevent). Pure
  // pending/in_progress queries are unaffected and keep their unbounded
  // start so overdue tasks always surface regardless of age.
  const includesHistoryStatus = statuses.some((s) => HISTORY_STATUSES.includes(s))
  if (includesHistoryStatus) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - HISTORY_LOOKBACK_DAYS)
    const cutoffStr = cutoff.toISOString().split('T')[0]
    dateFrom = dateFrom && dateFrom > cutoffStr ? dateFrom : cutoffStr
  }

  const db = await createServiceClient()
  let query = db
    .from('cultivation_tasks')
    .select(
      `*, room:grow_rooms(id, room_name, room_number), assigned_user:users!cultivation_tasks_assigned_to_fkey(id, name), completed_by_user:users!cultivation_tasks_completed_by_fkey(id, name), ${ASSIGNEES_EMBED}`,
      { count: 'exact' }
    )
    .or('frequency.is.null,recurring_parent_id.not.is.null')

  if (statuses.length > 0) {
    query = query.in('status', statuses)
  }
  if (dateFrom) {
    query = query.gte('due_date', dateFrom)
  }
  if (dateTo) {
    query = query.lte('due_date', dateTo)
  }

  // due_date ASC puts past-due and today first; priority DESC (critical
  // first) breaks ties within a day. Sort is applied server-side before
  // .range() so pagination is stable across pages.
  const { data, error, count } = await query
    .order('due_date', { ascending: true })
    .order('priority', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error('[cultivation] getCultivationTasks error:', error)
    return { error: 'Failed to load tasks' }
  }

  const rows = flattenAssignees(data ?? [])
  const totalCount = count ?? rows.length

  return {
    data: {
      tasks: rows,
      totalCount,
      hasMore: offset + rows.length < totalCount,
    },
  }
}

export async function getCultivationTaskSummary(): Promise<
  {
    data: { id: string; status: string; due_date: string; completed_at: string | null; room_id: string | null }[]
    error?: never
  } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('cultivation_tasks')
    .select('id, status, due_date, completed_at, room_id')
    .or('frequency.is.null,recurring_parent_id.not.is.null')

  if (error) {
    console.error('[cultivation] getCultivationTaskSummary error:', error)
    return { error: 'Failed to load task summary' }
  }
  return { data: data ?? [] }
}

export interface CultivationTaskCountsParams {
  /**
   * Client-local "today" as a YYYY-MM-DD string — used to bucket the
   * overdue/dueToday counts against due_date (a plain date column, so no
   * timezone conversion is needed once we have the caller's local date).
   */
  todayStr: string
  /**
   * ISO timestamp for the start of the client-local "today" — lower bound
   * (inclusive) for the completedToday count against completed_at.
   */
  completedTodayFrom: string
  /**
   * ISO timestamp for the start of the client-local "tomorrow" — upper
   * bound (exclusive) for the completedToday count against completed_at.
   */
  completedTodayTo: string
}

export interface CultivationTaskCounts {
  overdue: number
  dueToday: number
  inProgress: number
  completedToday: number
}

// Same "exclude recurring definition rows" filter used by getCultivationTasks
// — recurring parent/template rows aren't real due tasks, so they're never
// counted toward the stat cards.
const RECURRING_FILTER = 'frequency.is.null,recurring_parent_id.not.is.null'

/**
 * Backs the cultivation TASKS page's header stat cards (Overdue / Due Today
 * / In Progress / Completed Today). Deliberately count-only — no rows are
 * ever transferred to the client, just 4 integers, run in parallel via
 * `.select('*', { count: 'exact', head: true })`. Unfiltered by the page's
 * Timeframe/Status filters (matches getCultivationTaskSummary's previous
 * row-shipping semantics for these same 4 numbers), scoped only by:
 *   - overdue: status in (pending, in_progress) AND due_date < today
 *   - dueToday: status in (pending, in_progress) AND due_date = today
 *   - inProgress: status = in_progress (no date bound)
 *   - completedToday: status = completed AND completed_at falls within the
 *     caller's local "today" (via the completedTodayFrom/To ISO bounds)
 *
 * Note: getCultivationTaskSummary() above still ships full rows — it backs
 * the main cultivation dashboard's per-room breakdown and "upcoming this
 * week" count, which need row-level data this lean version doesn't provide.
 */
export async function getCultivationTaskCounts(
  params: CultivationTaskCountsParams
): Promise<
  { data: CultivationTaskCounts; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const [overdueRes, dueTodayRes, inProgressRes, completedTodayRes] = await Promise.all([
    db
      .from('cultivation_tasks')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'in_progress'])
      .lt('due_date', params.todayStr)
      .or(RECURRING_FILTER),
    db
      .from('cultivation_tasks')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'in_progress'])
      .eq('due_date', params.todayStr)
      .or(RECURRING_FILTER),
    db
      .from('cultivation_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'in_progress')
      .or(RECURRING_FILTER),
    db
      .from('cultivation_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', params.completedTodayFrom)
      .lt('completed_at', params.completedTodayTo)
      .or(RECURRING_FILTER),
  ])

  const firstError =
    overdueRes.error || dueTodayRes.error || inProgressRes.error || completedTodayRes.error
  if (firstError) {
    console.error('[cultivation] getCultivationTaskCounts error:', firstError)
    return { error: 'Failed to load task counts' }
  }

  return {
    data: {
      overdue: overdueRes.count ?? 0,
      dueToday: dueTodayRes.count ?? 0,
      inProgress: inProgressRes.count ?? 0,
      completedToday: completedTodayRes.count ?? 0,
    },
  }
}

export async function getMyTodayTasks(todayStr: string): Promise<
  { data: unknown[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  // Inner-join on cultivation_task_assignees so a task shows for EVERY
  // assignee, not just the (deprecated) single assigned_to column. Filtering
  // on an !inner-embedded resource restricts BOTH the parent rows (only
  // tasks where this user is an assignee) AND narrows the embedded rows
  // themselves to the matching assignee — that's fine here since this
  // endpoint doesn't render the full assignee list (see dashboard page).
  // Use server-side verified userId from session — never trust a client-passed id
  const { data, error } = await db
    .from('cultivation_tasks')
    .select(
      `*, room:grow_rooms(id, room_name, room_number), assigned_user:users!cultivation_tasks_assigned_to_fkey(id, name), cultivation_task_assignees!inner(user_id)`
    )
    .eq('cultivation_task_assignees.user_id', auth.session.userId)
    .in('status', ['pending', 'in_progress'])
    .or('frequency.is.null,recurring_parent_id.not.is.null')
    .lte('due_date', todayStr)
    .order('due_date')
    .limit(10)

  if (error) {
    console.error('[cultivation] getMyTodayTasks error:', error)
    return { error: 'Failed to load your tasks' }
  }

  return { data: data ?? [] }
}

export async function getCultivationTasksForDisplay(todayStr: string): Promise<
  { data: unknown[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('cultivation_tasks')
    .select(
      `*, room:grow_rooms(id, room_name, room_number), assigned_user:users!cultivation_tasks_assigned_to_fkey(id, name), ${ASSIGNEES_EMBED}`
    )
    .in('status', ['pending', 'in_progress'])
    .lte('due_date', todayStr)
    .or('frequency.is.null,recurring_parent_id.not.is.null')
    .order('due_date', { ascending: true })
    .order('priority', { ascending: false })

  if (error) {
    console.error('[cultivation] getCultivationTasksForDisplay error:', error)
    return { error: 'Failed to load tasks for display' }
  }

  return { data: flattenAssignees(data ?? []) }
}

// Eligible pool for the cultivation task assignee picker. Deliberately
// narrower than VIEW_ROLES (which also covers read-only visibility for
// vault/packaging/standard) — only roles that actually do grow work or
// manage the cultivation program should be assignable.
const ASSIGNABLE_ROLES = ['grow', 'management', 'admin']

export async function getCultivationUsers(): Promise<
  { data: { id: string; name: string; role: string }[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('users')
    .select('id, name, role')
    .in('role', ASSIGNABLE_ROLES)
    .order('name')

  if (error) {
    console.error('[cultivation] getCultivationUsers error:', error)
    return { error: 'Failed to load users' }
  }
  return { data: data ?? [] }
}

// ---------------------------------------------------------------------------
// Cultivation Tasks — mutations
// ---------------------------------------------------------------------------

export interface CompleteTaskInput {
  taskId: string
  completedBy: string
  notes: string | null
}

export async function completeTask(input: CompleteTaskInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(COMPLETE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('cultivation_tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: input.completedBy,
      completion_notes: input.notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.taskId)

  if (error) {
    console.error('[cultivation] completeTask error:', error)
    return { error: 'Failed to complete task' }
  }
  return {}
}

export async function startTask(taskId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(COMPLETE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('cultivation_tasks')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', taskId)

  if (error) {
    console.error('[cultivation] startTask error:', error)
    return { error: 'Failed to start task' }
  }
  return {}
}

export async function deleteTask(taskId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('cultivation_tasks').delete().eq('id', taskId)

  if (error) {
    console.error('[cultivation] deleteTask error:', error)
    return { error: 'Failed to delete task' }
  }
  return {}
}

export interface CreateTaskInput {
  title: string
  description: string | null
  room_id: string | null
  due_date: string
  priority: TaskPriority
  assignee_ids: string[]
  estimated_minutes: number | null
  task_type: string
  frequency: string | null
  day_of_week: number | null
  created_by: string
}

export async function createTask(input: CreateTaskInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const { assignee_ids, ...taskFields } = input
  const db = await createServiceClient()
  const { data: newTask, error } = await db
    .from('cultivation_tasks')
    .insert({
      ...taskFields,
      // Legacy compat — Bud Slack agent still reads assigned_to directly.
      assigned_to: assignee_ids[0] ?? null,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error || !newTask) {
    console.error('[cultivation] createTask error:', error)
    return { error: 'Failed to create task' }
  }

  if (assignee_ids.length > 0) {
    const { error: assigneeErr } = await db.from('cultivation_task_assignees').insert(
      assignee_ids.map((userId) => ({
        task_id: newTask.id,
        user_id: userId,
        assigned_by: input.created_by,
      }))
    )
    if (assigneeErr) {
      console.error('[cultivation] createTask assignee insert error:', assigneeErr)
      return { error: 'Task created, but failed to save assignees' }
    }
  }

  return {}
}

export interface UpdateTaskInput {
  title: string
  description: string | null
  room_id: string | null
  due_date: string
  priority: TaskPriority
  assignee_ids: string[]
  estimated_minutes: number | null
  task_type: string
  frequency: string | null
  day_of_week: number | null
}

export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }
  // Use server-side verified userId from session — never trust a client-passed id
  const actingUserId = auth.session.userId

  const { assignee_ids, ...taskFields } = input
  const db = await createServiceClient()
  const { error } = await db
    .from('cultivation_tasks')
    .update({
      ...taskFields,
      // Legacy compat — Bud Slack agent still reads assigned_to directly.
      assigned_to: assignee_ids[0] ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)

  if (error) {
    console.error('[cultivation] updateTask error:', error)
    return { error: 'Failed to update task' }
  }

  // Full-replace semantics: clear existing assignees, then re-insert.
  const { error: deleteErr } = await db
    .from('cultivation_task_assignees')
    .delete()
    .eq('task_id', taskId)

  if (deleteErr) {
    console.error('[cultivation] updateTask assignee clear error:', deleteErr)
    return { error: 'Task updated, but failed to clear previous assignees' }
  }

  if (assignee_ids.length > 0) {
    const { error: assigneeErr } = await db.from('cultivation_task_assignees').insert(
      assignee_ids.map((userId) => ({
        task_id: taskId,
        user_id: userId,
        assigned_by: actingUserId,
      }))
    )
    if (assigneeErr) {
      console.error('[cultivation] updateTask assignee insert error:', assigneeErr)
      return { error: 'Task updated, but failed to save assignees' }
    }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Grow Rooms — mutations
// ---------------------------------------------------------------------------

export interface UpsertGrowRoomInput {
  room_number: number
  room_name: string
  pairing_group: string | null
  notes: string | null
}

export async function createGrowRoom(input: UpsertGrowRoomInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('grow_rooms')
    .insert({ ...input, current_phase: 'empty' })

  if (error) {
    console.error('[cultivation] createGrowRoom error:', error)
    return { error: 'Failed to add room' }
  }
  return {}
}

export async function updateGrowRoom(roomId: string, input: UpsertGrowRoomInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('grow_rooms')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', roomId)

  if (error) {
    console.error('[cultivation] updateGrowRoom error:', error)
    return { error: 'Failed to update room' }
  }
  return {}
}

export async function deleteGrowRoom(roomId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('grow_rooms').delete().eq('id', roomId)

  if (error) {
    console.error('[cultivation] deleteGrowRoom error:', error)
    return { error: 'Failed to remove room' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Cycle Templates — reads
// ---------------------------------------------------------------------------

export async function getCycleTemplates(): Promise<
  { data: unknown[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('cycle_templates')
    .select('*, template_tasks(id)')
    .order('template_type', { ascending: false }) // master first
    .order('name')

  if (error) {
    console.error('[cultivation] getCycleTemplates error:', error)
    return { error: 'Failed to load templates' }
  }
  return { data: data ?? [] }
}

export async function getActiveMasterTemplates(): Promise<
  { data: CycleTemplate[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('cycle_templates')
    .select('*')
    .eq('template_type', 'master')
    .eq('is_active', true)
    .order('name')

  if (error) {
    console.error('[cultivation] getActiveMasterTemplates error:', error)
    return { error: 'Failed to load master templates' }
  }
  return { data: data as CycleTemplate[] }
}

export async function getTemplateTasks(templateId: string): Promise<
  { data: TemplateTask[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('template_tasks')
    .select('*')
    .eq('template_id', templateId)
    .order('day_number')
    .order('sort_order')

  if (error) {
    console.error('[cultivation] getTemplateTasks error:', error)
    return { error: 'Failed to load template tasks' }
  }
  return { data: data as TemplateTask[] }
}

// ---------------------------------------------------------------------------
// Cycle Templates — mutations
// ---------------------------------------------------------------------------

export interface UpsertTemplateInput {
  name: string
  template_type: TemplateType
  phase: string | null
  duration_days: number
  description: string | null
  is_active: boolean
}

export async function createCycleTemplate(
  input: UpsertTemplateInput,
  createdBy: string
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('cycle_templates').insert({ ...input, created_by: createdBy })

  if (error) {
    console.error('[cultivation] createCycleTemplate error:', error)
    return { error: 'Failed to create template' }
  }
  return {}
}

export async function updateCycleTemplate(
  templateId: string,
  input: UpsertTemplateInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('cycle_templates')
    .update(input)
    .eq('id', templateId)

  if (error) {
    console.error('[cultivation] updateCycleTemplate error:', error)
    return { error: 'Failed to update template' }
  }
  return {}
}

export async function toggleTemplateActive(
  templateId: string,
  isActive: boolean
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db
    .from('cycle_templates')
    .update({ is_active: isActive })
    .eq('id', templateId)

  if (error) {
    console.error('[cultivation] toggleTemplateActive error:', error)
    return { error: 'Failed to update template' }
  }
  return {}
}

export async function deleteCycleTemplate(templateId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  // Delete tasks first, then the template
  await db.from('template_tasks').delete().eq('template_id', templateId)

  const { error } = await db.from('cycle_templates').delete().eq('id', templateId)

  if (error) {
    console.error('[cultivation] deleteCycleTemplate error:', error)
    return { error: 'Failed to delete template' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Template Tasks — mutations
// ---------------------------------------------------------------------------

export interface UpsertTemplateTaskInput {
  name: string
  description: string | null
  day_number: number
  estimated_minutes: number | null
  priority: TaskPriority
  stage: string | null
}

export async function createTemplateTask(
  templateId: string,
  input: UpsertTemplateTaskInput,
  sortOrder: number
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('template_tasks').insert({
    ...input,
    template_id: templateId,
    sort_order: sortOrder,
  })

  if (error) {
    console.error('[cultivation] createTemplateTask error:', error)
    return { error: 'Failed to create task' }
  }
  return {}
}

export async function updateTemplateTask(
  taskId: string,
  input: UpsertTemplateTaskInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('template_tasks').update(input).eq('id', taskId)

  if (error) {
    console.error('[cultivation] updateTemplateTask error:', error)
    return { error: 'Failed to update task' }
  }
  return {}
}

export async function deleteTemplateTask(taskId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { error } = await db.from('template_tasks').delete().eq('id', taskId)

  if (error) {
    console.error('[cultivation] deleteTemplateTask error:', error)
    return { error: 'Failed to delete task' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Start Cycle — complex multi-table operation
// ---------------------------------------------------------------------------

export interface StartCycleInput {
  roomId: string
  templateId: string
  cycleNumber: number | null
  domeStart: string
  vegStart: string
  flowerStart: string
  harvestDate: string
  dryStart: string
  trimStart: string
  notes: string | null
  userId: string
}

export async function startCycle(input: StartCycleInput): Promise<
  { taskCount: number; cycleNum: number | null; error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  // 1. Create room_cycles with milestone dates
  const { data: newCycle, error: cycleErr } = await db
    .from('room_cycles')
    .insert({
      room_id: input.roomId,
      template_id: input.templateId,
      current_stage: 'dome',
      cycle_number: input.cycleNumber,
      start_date: input.domeStart,
      expected_end_date: input.trimStart,
      dome_start: input.domeStart,
      veg_start: input.vegStart,
      flower_start: input.flowerStart,
      harvest_date: input.harvestDate,
      dry_start: input.dryStart,
      trim_start: input.trimStart,
      status: 'active',
      notes: input.notes,
      created_by: input.userId,
    })
    .select('id')
    .single()

  if (cycleErr || !newCycle) {
    console.error('[cultivation] startCycle cycle insert error:', cycleErr)
    return { error: 'Failed to create cycle' }
  }

  // 2. Update grow_rooms
  await db
    .from('grow_rooms')
    .update({
      current_phase: 'dome',
      phase_start_date: input.domeStart,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.roomId)

  // 3. Generate all tasks from master template using milestone-anchored dates
  const { data: templateTasks } = await db
    .from('template_tasks')
    .select('*')
    .eq('template_id', input.templateId)
    .order('day_number')
    .order('sort_order')

  const milestones: Record<string, string> = {
    dome: input.domeStart,
    veg: input.vegStart,
    flower: input.flowerStart,
    harvest: input.harvestDate,
    dry: input.dryStart,
    trim: input.trimStart,
  }

  let taskCount = 0
  if (templateTasks && templateTasks.length > 0) {
    const tasksToInsert = templateTasks
      .filter((tt: TemplateTask) => tt.stage && milestones[tt.stage])
      .map((tt: TemplateTask) => {
        const milestoneDate = milestones[tt.stage!]
        const milestoneDateObj = new Date(milestoneDate + 'T00:00:00')
        const dueDate = new Date(milestoneDateObj)
        if (tt.day_number > 0) {
          dueDate.setDate(dueDate.getDate() + (tt.day_number - 1))
        } else {
          dueDate.setDate(dueDate.getDate() + tt.day_number)
        }
        return {
          room_cycle_id: newCycle.id,
          room_id: input.roomId,
          template_task_id: tt.id,
          title: tt.name,
          description: tt.description,
          task_type: 'scheduled' as const,
          phase: tt.stage,
          day_number: tt.day_number,
          due_date: dueDate.toISOString().split('T')[0],
          priority: tt.priority,
          estimated_minutes: tt.estimated_minutes,
          status: 'pending' as const,
          created_by: input.userId,
        }
      })

    await db.from('cultivation_tasks').insert(tasksToInsert)
    taskCount = tasksToInsert.length
  }

  return { taskCount, cycleNum: input.cycleNumber }
}

// ---------------------------------------------------------------------------
// Advance Stage — updates room_cycles and grow_rooms
// ---------------------------------------------------------------------------

export interface AdvanceStageInput {
  roomId: string
  cycleId: string
  nextStage: string
}

export async function advanceStage(input: AdvanceStageInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(MANAGE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const today = new Date().toISOString().split('T')[0]

  const [cycleResult, roomResult] = await Promise.all([
    db
      .from('room_cycles')
      .update({ current_stage: input.nextStage, updated_at: new Date().toISOString() })
      .eq('id', input.cycleId),
    db
      .from('grow_rooms')
      .update({
        current_phase: input.nextStage,
        phase_start_date: today,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.roomId),
  ])

  if (cycleResult.error || roomResult.error) {
    console.error('[cultivation] advanceStage error:', cycleResult.error || roomResult.error)
    return { error: 'Failed to advance stage' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Get last cycle number for a room (for auto-increment)
// ---------------------------------------------------------------------------

export async function getLastCycleNumber(roomId: string): Promise<
  { data: number | null; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()
  const { data } = await db
    .from('room_cycles')
    .select('cycle_number')
    .eq('room_id', roomId)
    .not('cycle_number', 'is', null)
    .order('cycle_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  return { data: data?.cycle_number ?? null }
}

// ---------------------------------------------------------------------------
// Generate recurring tasks (server-side)
// ---------------------------------------------------------------------------
//
// The actual generation logic lives in lib/cultivation/generate-recurring-
// tasks.ts — a plain module, NOT exported from this 'use server' file.
//
// SECURITY: every function exported from a 'use server' file is published by
// Next.js as its own public POST endpoint, reachable by anyone who knows the
// action id — regardless of client-side route guards or the document-only
// middleware redirect. generateRecurringTasksCore() is intentionally
// session-independent (it builds its own service-role client so the nightly
// Vercel Cron, which has no cookies, can call it), so if it were exported
// here too it would be a fully unauthenticated, world-callable service-role
// write endpoint — bypassing both the cron's CRON_SECRET check
// (app/api/cron/generate-recurring-tasks/route.ts) and the role-guarded
// wrapper below. Keeping it in a plain module means it can only be reached
// via an explicit import (the cron route, or generateRecurringTasksAction
// below), never via a direct action-id POST.

/**
 * Thin, role-guarded wrapper around generateRecurringTasksCore() — kept
 * exported for any future manual/UI-triggered invocation. The nightly
 * Vercel Cron (app/api/cron/generate-recurring-tasks/route.ts) calls
 * generateRecurringTasksCore() directly instead, since a cron request has
 * no session to check a role against.
 */
export async function generateRecurringTasksAction(): Promise<
  { generated: number; error?: never } | { error: string }
> {
  const auth = await requireRole(VIEW_ROLES)
  if (!auth.authorized) return { generated: 0 }
  return generateRecurringTasksCore()
}
