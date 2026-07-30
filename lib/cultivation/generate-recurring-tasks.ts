// Plain (non-'use server') module — deliberately NOT exported from a
// 'use server' file.
//
// SECURITY: every exported function in a 'use server' module is published by
// Next.js as its own POST endpoint, reachable by anyone who knows the action
// id — this is true regardless of client-side route guards or the
// document-only middleware redirect (see lib/supabase/middleware.ts). This
// module's generateRecurringTasksCore() builds its own service-role Supabase
// client and writes to cultivation_tasks with NO caller identity check by
// design (see its docstring below), so it must never live in a 'use server'
// file — doing so would let anyone on the internet trigger service-role
// writes directly, bypassing both the nightly cron's CRON_SECRET check
// (app/api/cron/generate-recurring-tasks/route.ts) and the role-guarded
// wrapper (generateRecurringTasksAction in actions/cultivation.ts).
//
// Previously this logic was duplicated: an older, unused, browser-client
// version lived here (generateRecurringTasks(), never imported by anything),
// while the real implementation (generateRecurringTasksCore()) lived inline
// in actions/cultivation.ts and was accidentally exported from that
// 'use server' file. This file now holds the one real implementation,
// imported by both the cron route and the role-guarded action.

import { createServiceClient } from '@/lib/supabase/server'

/**
 * How many days ahead to generate recurring task instances.
 * E.g. 14 means the generator will always ensure instances exist
 * from today through today+14.
 */
const LOOKAHEAD_DAYS = 14

/** Add `days` to a YYYY-MM-DD string and return a new YYYY-MM-DD string. */
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

/**
 * Build an ordered list of due-date strings that need to be generated for a
 * given recurrence pattern.
 */
function dueDatesNeeded(
  frequency: string,
  lastGenStr: string | null,
  todayStr: string,
  horizonStr: string,
  dayOfWeek: number | null,
  createdAt: string
): string[] {
  const dates: string[] = []

  switch (frequency) {
    case 'daily': {
      const startStr = lastGenStr ? addDaysToDateStr(lastGenStr, 1) : todayStr
      let cursor = startStr
      while (cursor <= horizonStr) {
        dates.push(cursor)
        cursor = addDaysToDateStr(cursor, 1)
      }
      break
    }

    case 'weekly': {
      const targetDay = dayOfWeek ?? 1
      const todayDate = new Date(todayStr + 'T00:00:00')
      const dayNum = todayDate.getDay() || 7
      const daysUntilTarget = ((targetDay - dayNum + 7) % 7) || 7
      const firstOccurrence = addDaysToDateStr(todayStr, daysUntilTarget === 7 ? 0 : daysUntilTarget)
      let cursor = firstOccurrence
      while (cursor <= horizonStr) {
        if (!lastGenStr || cursor > lastGenStr) {
          dates.push(cursor)
        }
        cursor = addDaysToDateStr(cursor, 7)
      }
      break
    }

    case 'biweekly': {
      const targetDay = dayOfWeek ?? 1
      const todayDate = new Date(todayStr + 'T00:00:00')
      const dayNum = todayDate.getDay() || 7
      const daysUntilTarget = ((targetDay - dayNum + 7) % 7) || 7
      const firstOccurrence = addDaysToDateStr(todayStr, daysUntilTarget === 7 ? 0 : daysUntilTarget)
      const createdDate = new Date(createdAt)
      let cursor = firstOccurrence
      while (cursor <= horizonStr) {
        const weeksSinceCreation = Math.floor(
          (new Date(cursor + 'T00:00:00').getTime() - createdDate.getTime()) /
            (7 * 24 * 60 * 60 * 1000)
        )
        if (weeksSinceCreation % 2 === 0 && (!lastGenStr || cursor > lastGenStr)) {
          dates.push(cursor)
        }
        cursor = addDaysToDateStr(cursor, 7)
      }
      break
    }

    case 'monthly': {
      const todayDate = new Date(todayStr + 'T00:00:00')
      const year = todayDate.getFullYear()
      const month = todayDate.getMonth()
      for (let i = 0; i < 3; i++) {
        const monthStart = new Date(year, month + i, 1)
        const monthStartStr = monthStart.toISOString().split('T')[0]
        if (monthStartStr <= horizonStr && (!lastGenStr || monthStartStr > lastGenStr)) {
          dates.push(monthStartStr)
        }
      }
      break
    }
  }

  return dates
}

/**
 * Core recurring-task generation logic. Session-independent — builds its
 * own service-role Supabase client, so it can be called from contexts with
 * no cookies/session (e.g. the nightly Vercel Cron route) as well as from
 * the thin, role-guarded action in actions/cultivation.ts.
 *
 * Deliberately lives in a plain module (not a 'use server' file) — see the
 * file-level comment above for why exporting this from a server-actions
 * module would be a public, unauthenticated write endpoint.
 */
export async function generateRecurringTasksCore(): Promise<
  { generated: number; error?: never } | { error: string }
> {
  try {
    const db = await createServiceClient()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayStr = today.toISOString().split('T')[0]
    const horizonStr = addDaysToDateStr(todayStr, LOOKAHEAD_DAYS)

    // Fetch all recurring definitions
    const { data: definitions, error } = await db
      .from('cultivation_tasks')
      .select('*')
      .not('frequency', 'is', null)
      .is('recurring_parent_id', null)
      .order('created_at')

    if (error || !definitions) return { generated: 0 }

    let generated = 0

    for (const def of definitions) {
      const needed = dueDatesNeeded(
        def.frequency,
        def.last_generated_date ?? null,
        todayStr,
        horizonStr,
        def.day_of_week ?? null,
        def.created_at
      )

      if (needed.length === 0) continue

      // Fetch existing children to avoid duplicates
      const { data: existing } = await db
        .from('cultivation_tasks')
        .select('due_date')
        .eq('recurring_parent_id', def.id)
        .gte('due_date', needed[0])
        .lte('due_date', needed[needed.length - 1])

      const existingDates = new Set((existing ?? []).map((r: { due_date: string }) => r.due_date))

      const toInsert = needed
        .filter((d) => !existingDates.has(d))
        .map((dueDate) => ({
          title: def.title,
          description: def.description,
          task_type: 'recurring',
          room_id: def.room_id,
          due_date: dueDate,
          priority: def.priority,
          estimated_minutes: def.estimated_minutes,
          // Legacy compat — Bud Slack agent still reads assigned_to directly.
          assigned_to: def.assigned_to,
          status: 'pending',
          recurring_parent_id: def.id,
          frequency: null,
          created_by: def.created_by,
        }))

      if (toInsert.length === 0) continue

      // Read the parent recurring definition's full assignee set once, so
      // every generated child inherits the same multi-assignee list (not
      // just the legacy single assigned_to column).
      const { data: parentAssignees } = await db
        .from('cultivation_task_assignees')
        .select('user_id, assigned_by')
        .eq('task_id', def.id)

      const { data: insertedTasks, error: insertError } = await db
        .from('cultivation_tasks')
        .insert(toInsert)
        .select('id')

      if (!insertError && insertedTasks) {
        generated += toInsert.length
        const maxDate = toInsert[toInsert.length - 1].due_date
        await db
          .from('cultivation_tasks')
          .update({ last_generated_date: maxDate })
          .eq('id', def.id)

        if (parentAssignees && parentAssignees.length > 0) {
          const assigneeRows = insertedTasks.flatMap((child: { id: string }) =>
            parentAssignees.map((pa: { user_id: string; assigned_by: string | null }) => ({
              task_id: child.id,
              user_id: pa.user_id,
              assigned_by: pa.assigned_by,
            }))
          )
          const { error: assigneeErr } = await db
            .from('cultivation_task_assignees')
            .insert(assigneeRows)
          if (assigneeErr) {
            console.error(
              '[cultivation] generateRecurringTasksCore assignee copy error:',
              assigneeErr
            )
          }
        }
      }
    }

    return { generated }
  } catch (err) {
    // Never block page load — recurring generation is best-effort
    console.error('[cultivation] generateRecurringTasksCore unexpected error:', err)
    return { generated: 0 }
  }
}
