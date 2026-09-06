'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import type { TaskStatus } from '@/types/database'

// Roles that can access tasks (mirrors canViewSection('tasks'))
const TASK_ROLES = ['admin', 'management', 'sales', 'agent'] as const

// Canonical statuses (SPRO-73). Normal workflow: todo → in_progress → done,
// plus cancelled. Kept as a runtime list so server-side validation and the
// DB CHECK constraint agree.
const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'] as const

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskWithCustomer {
  id: string
  agent_id: string
  customer_id: string | null
  title: string
  description: string | null
  due_date: string
  priority: number
  status: TaskStatus
  completed_at: string | null
  archived_at: string | null
  archived_by: string | null
  customer: {
    business_name: string
    license_name: string | null
    omma_license: string | null
    city: string | null
  } | null
}

export interface CreateTaskInput {
  customer_id: string | null
  title: string
  description: string | null
  due_date: string
  priority: number
}

export interface UpdateTaskInput {
  title: string
  description: string | null
  due_date: string
  status: TaskStatus
  /** New assignee — must be a user whose role can access tasks. */
  agent_id: string
}

export interface AssignableUser {
  id: string
  name: string
  role: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof createServiceClient>>

/**
 * Load a task and assert the caller may mutate it: the current assignee or an
 * admin. Authorization is always checked against the STORED assignment, never
 * against anything the client submitted.
 */
async function authorizeTaskMutation(
  db: Db,
  taskId: string,
  session: { userId: string; role: string }
): Promise<
  | { ok: true; task: { agent_id: string | null; archived_at: string | null } }
  | { ok: false; error: string }
> {
  const { data: existing, error: fetchError } = await db
    .from('sales_tasks')
    .select('agent_id, archived_at')
    .eq('id', taskId)
    .maybeSingle()

  if (fetchError || !existing) {
    return { ok: false, error: 'Task not found' }
  }

  if (existing.agent_id !== session.userId && session.role !== 'admin') {
    return { ok: false, error: 'Not authorized to update this task' }
  }

  return { ok: true, task: existing }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch active (non-archived) tasks for the current user (always scoped to
 * own agent_id).
 */
export async function getTasks(): Promise<
  { data: TaskWithCustomer[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('sales_tasks')
    .select(`
      *,
      customer:customers(business_name, license_name, omma_license, city)
    `)
    .eq('agent_id', auth.session.userId)
    .is('archived_at', null)
    .order('due_date', { ascending: true })

  if (error) {
    console.error('[tasks] getTasks error:', error)
    return { error: 'Failed to load tasks' }
  }

  return { data: (data as TaskWithCustomer[]) ?? [] }
}

/**
 * Fetch archived tasks for the current user (always scoped to own agent_id).
 * Archived tasks are recoverable via restoreTask().
 */
export async function getArchivedTasks(): Promise<
  { data: TaskWithCustomer[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('sales_tasks')
    .select(`
      *,
      customer:customers(business_name, license_name, omma_license, city)
    `)
    .eq('agent_id', auth.session.userId)
    .not('archived_at', 'is', null)
    .order('due_date', { ascending: true })

  if (error) {
    console.error('[tasks] getArchivedTasks error:', error)
    return { error: 'Failed to load archived tasks' }
  }

  return { data: (data as TaskWithCustomer[]) ?? [] }
}

/**
 * Fetch users a task may be assigned to (task-access roles only).
 * SECURITY: returns only id/name/role — never PINs or other sensitive fields.
 */
export async function getAssignableUsers(): Promise<
  { data: AssignableUser[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('users')
    .select('id, name, role')
    .in('role', [...TASK_ROLES])
    .order('name')

  if (error) {
    console.error('[tasks] getAssignableUsers error:', error)
    return { error: 'Failed to load users' }
  }

  return { data: (data as AssignableUser[]) ?? [] }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new sales task for the current user. New tasks always start as
 * 'todo'.
 */
export async function createTask(input: CreateTaskInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.title?.trim()) return { error: 'Title is required' }
  if (!input.due_date) return { error: 'Due date is required' }

  const db = await createServiceClient()

  const { error } = await db.from('sales_tasks').insert({
    agent_id: auth.session.userId,
    customer_id: input.customer_id || null,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    due_date: input.due_date,
    priority: input.priority,
    status: 'todo',
  })

  if (error) {
    console.error('[tasks] createTask error:', error)
    return { error: 'Failed to create task' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Edit a task's title, description, due date, status, and assignee.
 * Only the task's current assignee or an admin may edit.
 */
export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.title?.trim()) return { error: 'Title is required' }
  if (!input.due_date) return { error: 'Due date is required' }
  if (!isTaskStatus(input.status)) return { error: 'Invalid status' }
  if (!input.agent_id) return { error: 'Assignee is required' }

  const db = await createServiceClient()

  const authz = await authorizeTaskMutation(db, taskId, auth.session)
  if (!authz.ok) return { error: authz.error }
  if (authz.task.archived_at) return { error: 'Archived tasks must be restored before editing' }

  // Validate the new assignee is a real user with a task-access role. Never
  // trust the submitted id blindly — the service-role client bypasses RLS.
  const { data: assignee, error: assigneeError } = await db
    .from('users')
    .select('id, role')
    .eq('id', input.agent_id)
    .maybeSingle()

  if (assigneeError || !assignee) return { error: 'Assignee not found' }
  if (!(TASK_ROLES as readonly string[]).includes(assignee.role)) {
    return { error: 'Assignee cannot be given tasks' }
  }

  const { error } = await db
    .from('sales_tasks')
    .update({
      title: input.title.trim(),
      description: input.description?.trim() || null,
      due_date: input.due_date,
      status: input.status,
      agent_id: input.agent_id,
      // done stamps completion; every other status clears it
      completed_at: input.status === 'done' ? new Date().toISOString() : null,
    })
    .eq('id', taskId)

  if (error) {
    console.error('[tasks] updateTask error:', error)
    return { error: 'Failed to update task' }
  }

  return {}
}

/**
 * Change only a task's status (quick action from the list view).
 * Only the task's current assignee or an admin may change it.
 */
export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!isTaskStatus(status)) return { error: 'Invalid status' }

  const db = await createServiceClient()

  const authz = await authorizeTaskMutation(db, taskId, auth.session)
  if (!authz.ok) return { error: authz.error }
  if (authz.task.archived_at) return { error: 'Archived tasks must be restored before editing' }

  const { error } = await db
    .from('sales_tasks')
    .update({
      status,
      completed_at: status === 'done' ? new Date().toISOString() : null,
    })
    .eq('id', taskId)

  if (error) {
    console.error('[tasks] updateTaskStatus error:', error)
    return { error: 'Failed to update task' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Archive / restore (soft delete — never a hard delete)
// ---------------------------------------------------------------------------

/**
 * Archive (soft-delete) a task. The row is kept and recoverable via
 * restoreTask(). Only the task's current assignee or an admin may archive.
 */
export async function archiveTask(taskId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const authz = await authorizeTaskMutation(db, taskId, auth.session)
  if (!authz.ok) return { error: authz.error }

  const { error } = await db
    .from('sales_tasks')
    .update({
      archived_at: new Date().toISOString(),
      archived_by: auth.session.userId,
    })
    .eq('id', taskId)

  if (error) {
    console.error('[tasks] archiveTask error:', error)
    return { error: 'Failed to archive task' }
  }

  return {}
}

/**
 * Restore a previously archived task back to the active list.
 * Only the task's current assignee or an admin may restore.
 */
export async function restoreTask(taskId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...TASK_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const authz = await authorizeTaskMutation(db, taskId, auth.session)
  if (!authz.ok) return { error: authz.error }

  const { error } = await db
    .from('sales_tasks')
    .update({
      archived_at: null,
      archived_by: null,
    })
    .eq('id', taskId)

  if (error) {
    console.error('[tasks] restoreTask error:', error)
    return { error: 'Failed to restore task' }
  }

  return {}
}
