-- ─── Phase-switcher tasks ───────────────────────────────────────────────────
--
-- Today a cultivation cycle's current_stage only changes when someone clicks
-- "Advance Stage" (admin/management only, on the room card) — an easy step
-- to forget. Three cycles were found drifted from their real stage in a
-- single day, one stale for three weeks, while the crew reliably checks off
-- their tasks every day.
--
-- This migration lets certain template tasks act as "phase switchers":
-- completing one advances the cycle's current_stage to that task's phase, as
-- a byproduct of work the crew already does — no new habit required. It is
-- an EXPLICIT flag, never inferred from day_number or position: several of
-- these switcher tasks share their day-1 slot with other, non-switcher
-- tasks (e.g. "Harvest" is one of FOUR day-1 tasks in the harvest phase), so
-- position alone can't disambiguate which task is the switcher.
--
-- template_tasks.is_phase_switcher is the authored flag, set on the master
-- template. cultivation_tasks.is_phase_switcher is a DENORMALIZED copy,
-- snapshotted at task-generation time (startCycle in actions/cultivation.ts)
-- — cultivation_tasks.template_task_id references template_tasks.id with
-- ON DELETE SET NULL, so the join back to the originating template task
-- can't be relied on indefinitely (the template can be edited/deleted after
-- a cycle has already been generated from it). Reading the denormalized
-- column directly off cultivation_tasks is the only reliable way to know,
-- at completion/reopen time, whether a given task instance is a switcher.
--
-- The partial unique index below (one row per (template_id, stage) where
-- is_phase_switcher is true) is the actual enforcement point for the product
-- rule "one switcher per phase per template". Application code
-- (createTemplateTask/updateTemplateTask in actions/cultivation.ts) checks
-- for a conflict first and raises a friendly error, but this index is what
-- guarantees the invariant can never be violated, including by future code
-- paths that skip the application-level check.

alter table template_tasks
  add column is_phase_switcher boolean not null default false;

alter table cultivation_tasks
  add column is_phase_switcher boolean not null default false;

create unique index template_tasks_one_switcher_per_phase
  on template_tasks (template_id, stage)
  where is_phase_switcher and stage is not null;

-- ─── Backfill (a) ───────────────────────────────────────────────────────────
-- Flag the five known switcher tasks (verified against prod) on the master
-- template(s). Matched on (name, stage) TOGETHER so a same-named task
-- sitting in a different stage isn't accidentally caught.
update template_tasks tt
set is_phase_switcher = true
from cycle_templates ct
where tt.template_id = ct.id
  and ct.template_type = 'master'
  and (tt.name, tt.stage) in (
    ('Transplant to veg', 'veg'),
    ('Flip to flower + Oxiphos spray', 'flower'),
    ('Harvest', 'harvest'),
    ('Move into holding room', 'dry'),
    ('Trim start', 'trim')
  );

-- ─── Backfill (b) ───────────────────────────────────────────────────────────
-- Propagate the flag onto already-generated cultivation_tasks so the ~8 live
-- cycles pick this up immediately, rather than only cycles started after
-- this migration. Joins through template_task_id, which is still populated
-- for every task generated so far.
update cultivation_tasks ct
set is_phase_switcher = true
from template_tasks tt
where ct.template_task_id = tt.id
  and tt.is_phase_switcher = true;
