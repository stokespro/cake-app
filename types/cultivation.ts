export type GrowPhase = 'empty' | 'dome' | 'veg' | 'flower' | 'harvest' | 'dry' | 'trim'
export type PipelineStage = 'dome' | 'veg' | 'flower' | 'harvest' | 'dry' | 'trim'
export type TemplateType = 'master' | 'phase'

export const STAGE_ORDER: PipelineStage[] = ['dome', 'veg', 'flower', 'harvest', 'dry', 'trim']

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type CultivationTaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'
export type CultivationTaskType = 'scheduled' | 'adhoc' | 'recurring'
export type CycleStatus = 'active' | 'completed' | 'cancelled'
export type CycleEndOutcome = 'completed' | 'cancelled'

export const PHASE_CONFIG: Record<GrowPhase, { label: string; color: string }> = {
  empty:   { label: 'Empty',   color: 'gray' },
  dome:    { label: 'Dome',    color: 'teal' },
  veg:     { label: 'Veg',     color: 'green' },
  flower:  { label: 'Flower',  color: 'purple' },
  harvest: { label: 'Harvest', color: 'amber' },
  dry:     { label: 'Dry',     color: 'orange' },
  trim:    { label: 'Trim',    color: 'rose' },
}

export interface GrowRoom {
  id: string
  room_number: number
  room_name: string
  pairing_group: string | null
  current_phase: GrowPhase
  phase_start_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CycleTemplate {
  id: string
  name: string
  template_type: TemplateType
  phase: string | null
  description: string | null
  duration_days: number | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface TemplateTask {
  id: string
  template_id: string
  name: string
  description: string | null
  day_number: number
  day_of_week: number | null
  estimated_minutes: number | null
  priority: TaskPriority
  sort_order: number
  stage: string | null
  /** Completing a cultivation_tasks row generated from this template task
   *  advances its cycle's current_stage to `stage`. See migration
   *  20260812120000_add_phase_switcher.sql. Meaningless without `stage` set. */
  is_phase_switcher: boolean
  created_at: string
  updated_at: string
}

export interface RoomCycle {
  id: string
  room_id: string
  template_id: string | null
  current_stage: string
  cycle_number: number | null
  start_date: string
  expected_end_date: string | null
  actual_end_date: string | null
  dome_start: string | null
  veg_start: string | null
  flower_start: string | null
  harvest_date: string | null
  dry_start: string | null
  trim_start: string | null
  status: CycleStatus
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export const MILESTONE_FIELD: Record<PipelineStage, string> = {
  dome: 'dome_start',
  veg: 'veg_start',
  flower: 'flower_start',
  harvest: 'harvest_date',
  dry: 'dry_start',
  trim: 'trim_start',
}

export interface CultivationTask {
  id: string
  room_cycle_id: string | null
  room_id: string | null
  template_task_id: string | null
  title: string
  description: string | null
  task_type: CultivationTaskType
  phase: string | null
  day_number: number | null
  due_date: string
  priority: TaskPriority
  estimated_minutes: number | null
  /** @deprecated Use `assignees` instead. Kept for legacy compat — Bud Slack agent still reads this column. Server actions keep it in sync as assignees[0]. */
  assigned_to: string | null
  assigned_group: string | null
  status: CultivationTaskStatus
  completed_at: string | null
  completed_by: string | null
  completion_notes: string | null
  attachments: any[]
  created_by: string | null
  frequency?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null
  day_of_week?: number | null
  recurring_parent_id?: string | null
  last_generated_date?: string | null
  /** Denormalized from the originating template_tasks row at generation time
   *  — see migration 20260812120000_add_phase_switcher.sql. When true (and
   *  `phase`/`room_cycle_id` are set), completing this task advances its
   *  cycle's current_stage to `phase` (see resolveSwitcherAdvance in
   *  lib/cultivation/helpers.ts and completeTask in actions/cultivation.ts). */
  is_phase_switcher: boolean
  created_at: string
  updated_at: string
  // Joined
  room?: GrowRoom
  cycle?: Pick<RoomCycle, 'id' | 'cycle_number' | 'current_stage' | 'flower_start' | 'status'> | null
  /** @deprecated Use `assignees` instead. Kept for legacy compat (single-assignee join). */
  assigned_user?: { id: string; name: string }
  completed_by_user?: { id: string; name: string }
  /** Full multi-assignee list, via cultivation_task_assignees. */
  assignees?: { id: string; name: string }[]
}
