-- SPRO-73: CRUD actions on sales tasks.
--
-- 1. Four canonical statuses — todo / in_progress / done / cancelled —
--    replacing the legacy pending / complete pair.
-- 2. Recoverable soft-delete (archive) instead of hard delete: archived_at /
--    archived_by metadata. Archived rows are excluded from every active-task
--    query; a restore simply clears the columns.
--
-- ORDER OF OPERATIONS MATTERS: every legacy restriction on the status column
-- (whatever it is called, and whether it is a CHECK constraint, a non-text
-- column type such as an enum/domain, or both) is removed via catalog lookups
-- BEFORE any row is rewritten, so the backfill UPDATEs can never be rejected
-- by a restriction this migration has not seen.
--
-- Written without live-DB inspection. It was exercised against simulated
-- legacy states (see PR notes): text column with the conventionally named
-- sales_tasks_status_check; text column with a differently named CHECK;
-- status as a pending/complete enum with an enum-typed default; no
-- restriction at all with junk/NULL values; and a re-run after a previous
-- successful application (idempotent). Remaining prerequisite before applying
-- to production: confirm no trigger or view depends on the legacy
-- pending/complete literals — that cannot be ruled out from the repository
-- alone.

-- Archival metadata -----------------------------------------------------------

ALTER TABLE public.sales_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES public.users(id);

-- Remove legacy status restrictions -------------------------------------------
-- Must happen before the backfill below: an old CHECK permitting only
-- pending/complete, or an enum type without the new labels, would otherwise
-- reject the UPDATEs.

DO $$
DECLARE
  status_type OID;
  con RECORD;
BEGIN
  SELECT a.atttypid
    INTO status_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.sales_tasks'::regclass
     AND a.attname = 'status'
     AND NOT a.attisdropped;

  IF status_type IS NULL THEN
    RAISE EXCEPTION 'public.sales_tasks.status column not found';
  END IF;

  -- If status is not plain text (enum, domain, varchar, ...), convert it.
  -- The default is dropped first because an enum-typed default cannot
  -- survive the type change; the canonical default is reinstated below.
  IF status_type <> 'text'::regtype THEN
    EXECUTE 'ALTER TABLE public.sales_tasks ALTER COLUMN status DROP DEFAULT';
    EXECUTE 'ALTER TABLE public.sales_tasks ALTER COLUMN status TYPE text USING status::text';
  END IF;

  -- Drop EVERY check constraint that covers the status column, regardless of
  -- name — the conventional sales_tasks_status_check cannot be assumed.
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.sales_tasks'::regclass
       AND c.contype = 'c'
       AND EXISTS (
         SELECT 1
           FROM unnest(c.conkey) AS k(attnum)
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE a.attname = 'status'
       )
  LOOP
    EXECUTE format('ALTER TABLE public.sales_tasks DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

-- Status backfill ---------------------------------------------------------------
-- Safe now: no restriction on the column remains.

UPDATE public.sales_tasks SET status = 'todo' WHERE status = 'pending';
UPDATE public.sales_tasks SET status = 'done' WHERE status = 'complete';

-- Defensive normalization: NULL or any value outside the canonical set
-- (unknown legacy states) maps to done when the task was already completed,
-- todo otherwise, so the CHECK below can never fail to validate.
UPDATE public.sales_tasks
SET status = CASE WHEN completed_at IS NOT NULL THEN 'done' ELSE 'todo' END
WHERE status IS NULL
   OR status NOT IN ('todo', 'in_progress', 'done', 'cancelled');

-- Canonical restriction ---------------------------------------------------------

ALTER TABLE public.sales_tasks ALTER COLUMN status SET DEFAULT 'todo';
-- The backfill above eliminated NULLs; the app's TaskStatus type is non-null.
ALTER TABLE public.sales_tasks ALTER COLUMN status SET NOT NULL;

-- The DO block above dropped every status CHECK, so a plain ADD is exact here
-- (and stays correct on a re-run of this file).
ALTER TABLE public.sales_tasks
  ADD CONSTRAINT sales_tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled'));

-- Active-list index -----------------------------------------------------------

-- getTasks() and the dashboard both read "this agent's non-archived tasks
-- ordered by due date"; the partial index covers exactly that shape.
CREATE INDEX IF NOT EXISTS idx_sales_tasks_active
  ON public.sales_tasks (agent_id, due_date)
  WHERE archived_at IS NULL;
