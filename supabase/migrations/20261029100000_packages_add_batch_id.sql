-- SPRO-235: link packages to batches with a real FK.
--
-- packages.batch is a free-text copy of batches.name (and strain/strain_id are copies of the
-- batch's strain) with no FK. This adds packages.batch_id -> batches(id) as the source of truth.
-- The next migration (20261029110000) adds triggers that keep the copied columns in sync.
--
-- batch_id stays NULLABLE here so the code deploy can land before the NOT NULL step
-- (20261029120000). ON DELETE RESTRICT: a batch with packages cannot be deleted.
--
-- Backfill: exact name match first, then a lower(btrim()) match only where exactly one batch
-- candidate exists. Verified on prod: every package matches a batch by exact name.

BEGIN;

ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS batch_id uuid;

ALTER TABLE public.packages
  ADD CONSTRAINT packages_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES public.batches(id) ON DELETE RESTRICT
  NOT VALID;

-- 1) exact name match
UPDATE public.packages p
   SET batch_id = b.id
  FROM public.batches b
 WHERE p.batch_id IS NULL
   AND b.name = p.batch;

-- 2) fallback: case/whitespace-insensitive, only when a single batch candidate exists
UPDATE public.packages p
   SET batch_id = m.id
  FROM (
    SELECT p2.tag_id, (array_agg(b.id))[1] AS id
      FROM public.packages p2
      JOIN public.batches b ON lower(btrim(b.name)) = lower(btrim(p2.batch))
     WHERE p2.batch_id IS NULL
     GROUP BY p2.tag_id
    HAVING count(*) = 1
  ) m
 WHERE p.tag_id = m.tag_id
   AND p.batch_id IS NULL;

ALTER TABLE public.packages VALIDATE CONSTRAINT packages_batch_id_fkey;

CREATE INDEX IF NOT EXISTS idx_packages_batch_id ON public.packages (batch_id);

COMMIT;
