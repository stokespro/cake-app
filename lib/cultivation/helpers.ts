import { differenceInCalendarDays } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import type { GrowRoom, RoomCycle, TaskPriority, PipelineStage } from '@/types/cultivation'
import { PHASE_CONFIG, STAGE_ORDER } from '@/types/cultivation'

// ─── Constants ───────────────────────────────────────────────────────────────

export const PRIORITY_BADGE: Record<TaskPriority, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-500 text-white',
  low: 'bg-gray-400 text-white',
}

export const PHASE_BADGE_CLASSES: Record<string, string> = {
  empty: 'bg-gray-500 text-white',
  dome: 'bg-teal-600 text-white',
  veg: 'bg-green-600 text-white',
  flower: 'bg-purple-600 text-white',
  harvest: 'bg-amber-600 text-white',
  dry: 'bg-orange-600 text-white',
  trim: 'bg-rose-600 text-white',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getDayProgress(
  activeCycle: RoomCycle | undefined
): { current: number; total: number } | null {
  if (!activeCycle?.start_date || !activeCycle?.expected_end_date) return null
  const startDate = parseLocalDate(activeCycle.start_date)
  const endDate = parseLocalDate(activeCycle.expected_end_date)
  const totalDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (totalDays <= 0) return null
  const currentDay =
    Math.floor(
      (new Date().getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    ) + 1
  return { current: Math.max(Math.min(currentDay, totalDays), 1), total: totalDays }
}

export function getPairingLabel(room: GrowRoom, rooms: GrowRoom[]): string | null {
  if (!room.pairing_group) return null
  const paired = rooms.find(
    (r) => r.pairing_group === room.pairing_group && r.id !== room.id
  )
  if (!paired) return null
  return `Paired with ${paired.room_name}`
}

/**
 * Week of flower for a cycle currently in the flower stage, 1-indexed.
 * Week 1 covers the first seven days of flower (day 0-6 since flowerStart).
 *
 * Returns null when flowerStart is missing so callers can fall back to a
 * plain "Flower" label. Clamps to 1 if `today` is before `flowerStart`
 * (e.g. a cycle advanced to flower ahead of its scheduled date).
 *
 * Uses `differenceInCalendarDays` (calendar-date subtraction), not a raw
 * millisecond-delta divide-by-86400000 — Oklahoma observes DST, flower runs
 * ~9-10 weeks, and a millisecond delta measures a DST spring-forward day as
 * 23 hours, which floors a true 10-day span down to 9 and shows the wrong
 * week a day early. Calendar-day diffing is immune to that.
 */
export function getFlowerWeek(flowerStart: string | null, today: Date = new Date()): number | null {
  if (!flowerStart) return null
  const start = parseLocalDate(flowerStart)
  const daysSince = differenceInCalendarDays(today, start)
  if (daysSince < 0) return 1
  return Math.floor(daysSince / 7) + 1
}

/**
 * Composes the display label for a cycle's current stage — e.g. "Flower W3"
 * for an in-progress flower stage (falling back to plain "Flower" when the
 * week can't be computed), or the normal PHASE_CONFIG label for any other
 * stage. Falls back to the raw stage string for unrecognized stages.
 */
export function getCycleStageLabel(
  stage: string,
  flowerStart: string | null,
  today: Date = new Date()
): string {
  if (stage === 'flower') {
    const week = getFlowerWeek(flowerStart, today)
    return week ? `Flower W${week}` : 'Flower'
  }
  return PHASE_CONFIG[stage as keyof typeof PHASE_CONFIG]?.label || stage
}

// ─── Cycle date anchoring ────────────────────────────────────────────────────

/** Milestone start date for each pipeline stage, as YYYY-MM-DD strings. */
export type CycleMilestones = Record<PipelineStage, string>

/**
 * Resolves a scheduled task's due date from its phase's milestone date and
 * its template `day_number` offset.
 *
 * Contract (do not change without updating both callers — startCycle and
 * updateCycle in actions/cultivation.ts):
 *   - `day_number > 0` is 1-indexed relative to the milestone date, so day 1
 *     lands ON the milestone date itself (offset of `day_number - 1` days).
 *   - `day_number <= 0` is a raw offset from the milestone date (used for
 *     prep tasks scheduled before the milestone, e.g. day -2).
 */
export function resolveTaskDueDate(
  milestones: CycleMilestones,
  phase: string,
  dayNumber: number
): string {
  const milestoneDate = milestones[phase as PipelineStage]
  const milestoneDateObj = new Date(milestoneDate + 'T00:00:00')
  const dueDate = new Date(milestoneDateObj)
  if (dayNumber > 0) {
    dueDate.setDate(dueDate.getDate() + (dayNumber - 1))
  } else {
    dueDate.setDate(dueDate.getDate() + dayNumber)
  }
  return dueDate.toISOString().split('T')[0]
}

/**
 * Inverse of resolveTaskDueDate() above: given a cycle's milestone dates and
 * a due date, determines which phase the cycle is in on that date and what
 * day-of-phase that due date represents.
 *
 * Contract (do not change without updating both callers — createTask and
 * updateTask in actions/cultivation.ts):
 *   - Only milestones that are non-null AND non-empty are considered.
 *     Callers commonly coalesce a missing DB value to `''` (see reopenTask,
 *     startCycle, updateCycle in actions/cultivation.ts) — that's only safe
 *     there because of an immediate truthiness check. Here we filter it out
 *     directly rather than letting `''` sort as "earliest date" and
 *     silently win a comparison it has no business winning.
 *   - Candidates are the milestones whose date is <= dueDate. The candidate
 *     with the LATEST date wins. This is a comparison of actual date values,
 *     NOT a lookup by STAGE_ORDER index — startCycle never validates that
 *     milestones are stored in stage order (only updateCycle does), so dates
 *     can genuinely be out of order.
 *   - Tie-break: when two milestones land on the same date, the one LATER in
 *     STAGE_ORDER wins. This is not a rare edge case: flip-room-dialog.tsx
 *     defaults `dry_start` to `harvest_date`, so `harvest_date ===
 *     dry_start` on essentially every cycle created through the normal UI
 *     flow. Without this tie-break, a task due on that date would be
 *     miscategorized as "harvest" instead of "dry".
 *   - `day_number = differenceInCalendarDays(dueDate, milestoneDate) + 1`,
 *     so it is always >= 1 and round-trips exactly through
 *     resolveTaskDueDate. Uses `differenceInCalendarDays` (not raw
 *     millisecond math) for the same DST-safety reason getFlowerWeek does
 *     above.
 *   - Returns null when dueDate is before every known milestone (e.g. a task
 *     scheduled ahead of the cycle's dome_start). Callers must NOT invent a
 *     negative day_number here — a negative day_number means "authored prep
 *     task" elsewhere in this codebase, and the two must not be conflated.
 */
export function resolveTaskPhaseAndDay(
  milestones: CycleMilestones,
  dueDate: string
): { phase: PipelineStage; day_number: number } | null {
  let best: { stage: PipelineStage; date: string } | null = null

  for (const stage of STAGE_ORDER) {
    const date = milestones[stage]
    if (!date || date > dueDate) continue
    // Iterating STAGE_ORDER in order and updating on `>=` (not `>`) means a
    // same-date milestone later in STAGE_ORDER naturally overwrites an
    // earlier one — that's the tie-break described above.
    if (!best || date >= best.date) {
      best = { stage, date }
    }
  }

  if (!best) return null

  const dayNumber = differenceInCalendarDays(parseLocalDate(dueDate), parseLocalDate(best.date)) + 1

  return { phase: best.stage, day_number: dayNumber }
}
