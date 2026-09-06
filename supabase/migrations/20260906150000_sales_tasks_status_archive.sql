-- SPRO-73: CRUD actions on sales tasks.
--
-- 1. Four canonical statuses — todo / in_progress / done / cancelled —
--    replacing the legacy pending / complete pair.
-- 2. Recoverable soft-delete (archive) instead of hard delete: archived_at /
--    archived_by metadata. Archived rows are excluded from every active-task
--    query; a restore simply clears the columns.
--
-- Written without live-DB inspection (see PR notes): every step is guarded
-- (IF NOT EXISTS / DROP ... IF EXISTS) and the status backfill normalizes any
-- unexpected legacy value before the CHECK constraint is added, so the
-- migration is safe to apply to whatever state the live table is in.

-- Archival metadata -----------------------------------------------------------

ALTER TABLE sales_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);

-- Status migration ------------------------------------------------------------

UPDATE sales_tasks SET status = 'todo'  WHERE status = 'pending';
UPDATE sales_tasks SET status = 'done'  WHERE status = 'complete';

-- Defensive normalization: any value outside the canonical set (unknown
-- legacy states) maps to done when the task was already completed, todo
-- otherwise, so the CHECK below can never fail to validate.
UPDATE sales_tasks
SET status = CASE WHEN completed_at IS NOT NULL THEN 'done' ELSE 'todo' END
WHERE status NOT IN ('todo', 'in_progress', 'done', 'cancelled');

ALTER TABLE sales_tasks ALTER COLUMN status SET DEFAULT 'todo';

ALTER TABLE sales_tasks DROP CONSTRAINT IF EXISTS sales_tasks_status_check;
ALTER TABLE sales_tasks
  ADD CONSTRAINT sales_tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled'));

-- Active-list index -----------------------------------------------------------

-- getTasks() and the dashboard both read "this agent's non-archived tasks
-- ordered by due date"; the partial index covers exactly that shape.
CREATE INDEX IF NOT EXISTS idx_sales_tasks_active
  ON sales_tasks (agent_id, due_date)
  WHERE archived_at IS NULL;
