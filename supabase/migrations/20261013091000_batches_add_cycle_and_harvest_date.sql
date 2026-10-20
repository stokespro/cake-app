-- Harvest & Trim, Phase 0 (2 of 3): give `batches` a real provenance link.
-- Plan: .context/harvest-trim-plan.md  (section 2.4, R2.5, R2.10).
--
-- WHY: today a batch's room/harvest provenance exists only inside a hand-typed name
-- (`MMDD-F<room>-<STRAIN>[-n]`), and it has already been typo'd in production (`0723-F!-CM`).
-- `room_cycle_id` makes the cycle -> batch relationship a real FK; the name becomes a display
-- convention, not a join key. It is load-bearing in both directions: the harvest crew declares
-- batches at the flower -> harvest advance, trim loads hang off them, and the inventory manager
-- later attaches the COA to the SAME row in vault admin (R2.10), so there is no second "create the
-- batch" step after trim.
--
--   room_cycle_id  uuid NULL  REFERENCES room_cycles(id) ON DELETE RESTRICT
--       Nullable: the 134 legacy rows stay NULL until linked (most never will be: room_cycles only
--       has 14 rows). RESTRICT: a cycle that has batches cannot be silently deleted.
--       NOTE this module never WRITES room_cycles or grow_rooms. Cycle milestone dates are
--       authoritative (a late phase flip compresses a phase, harvest never moves); the default
--       harvest_date is READ from room_cycles.harvest_date and never written back.
--   harvest_date   date NULL
--       The day THIS batch's plants were cut (a room can be cut over two days), so it is not simply
--       room_cycles.harvest_date. Known acceptable drift: it will not follow a later Edit Cycle date
--       change.
--
-- No `batches.status` column, deliberately: lifecycle is derivable (declared / in trim / awaiting
-- test / tested / sellable via is_active) and a status enum would duplicate `is_active` into two
-- sources of truth. Batches created by this module are is_active = false; nothing in this module
-- ever sets is_active = true (trim-complete is not sellable; the inventory manager flips it in
-- vault admin when the COA is in hand).
--
-- Additive and instant: two nullable columns plus a partial index, no table rewrite, no data touched.
-- The backfill is a SEPARATE migration (20261013092000, intentionally NOT in this PR). Run the
-- dry-run below first, read-only, and only apply the UPDATE migration after reviewing its output.
-- Rules for that backfill: never rename, never force a link. `0723-F!-CM` fails the name regex and
-- stays unlinked; do NOT rename it (packages.batch is free text joined by name and updateBatch does
-- not cascade, so a rename orphans its packages). Link it by id with a one-line UPDATE if wanted.
--
-- Do NOT apply manually. Joshua applies via Supabase MCP after the PR merges
-- (merged != applied: verify supabase_migrations.schema_migrations afterwards).
--
-- =====================================================================================
-- DRY RUN (read-only SELECT). Paste into execute_sql. It writes nothing and can be run
-- BEFORE or AFTER this migration (it never references the new columns).
--
-- One row per batch. Reads:
--   parsed_harvest_date  year = year of created_at, minus one if the MMDD lands > 30 days after
--                        created_at. NULL when the name does not start with a valid MMDD-.
--   room_no              the n in `-F<n>-`. NULL when the name has no such segment (`F!` -> NULL).
--   candidate_cycle_ids  room_cycles for grow_rooms.room_number = room_no whose harvest_date has the
--                        same month and day as parsed_harvest_date.
--   verdict              LINK_CANDIDATE (exactly one match - the only rows a backfill would touch)
--                        | AMBIGUOUS (2+ cycles match) | NO_CYCLE_MATCH | NO_ROOM_MATCH
--                        | NO_ROOM_IN_NAME | NO_DATE_IN_NAME
--   year_gap_days        |candidate harvest_date - parsed_harvest_date| for the single match, so a
--                        month/day match that is really a different year stands out.
--
-- WITH parsed AS (
--   SELECT b.id, b.name, b.created_at, b.is_active,
--          (regexp_match(b.name, '^(\d{2})(\d{2})-'))[1]::int          AS mm,
--          (regexp_match(b.name, '^(\d{2})(\d{2})-'))[2]::int          AS dd,
--          (regexp_match(b.name, '-[Ff](\d+)(?:-|$)'))[1]::int         AS room_no
--   FROM public.batches b
-- ), dated AS (
--   SELECT p.*,
--          -- nested CASE: make_date() must never see an impossible month/day (e.g. 0231).
--          CASE WHEN p.created_at IS NOT NULL AND p.mm BETWEEN 1 AND 12 AND p.dd >= 1 THEN
--            CASE WHEN p.dd <= extract(day FROM (
--                        make_date(extract(year FROM p.created_at)::int, p.mm, 1)
--                        + interval '1 month' - interval '1 day'))::int
--                 THEN make_date(extract(year FROM p.created_at)::int, p.mm, p.dd)
--            END
--          END AS d0
--   FROM parsed p
-- ), final AS (
--   SELECT d.*,
--          CASE WHEN d.d0 IS NULL THEN NULL
--               WHEN d.d0 - d.created_at::date > 30 THEN (d.d0 - interval '1 year')::date
--               ELSE d.d0 END AS parsed_harvest_date
--   FROM dated d
-- )
-- SELECT f.id, f.name, f.created_at::date AS created_on, f.is_active,
--        f.parsed_harvest_date, f.room_no,
--        gr.room_name,
--        COALESCE(array_agg(rc.id ORDER BY rc.harvest_date) FILTER (WHERE rc.id IS NOT NULL), '{}') AS candidate_cycle_ids,
--        count(rc.id)                                                            AS match_count,
--        CASE WHEN f.parsed_harvest_date IS NULL THEN 'NO_DATE_IN_NAME'
--             WHEN f.room_no IS NULL             THEN 'NO_ROOM_IN_NAME'
--             WHEN gr.id IS NULL                 THEN 'NO_ROOM_MATCH'
--             WHEN count(rc.id) = 0              THEN 'NO_CYCLE_MATCH'
--             WHEN count(rc.id) = 1              THEN 'LINK_CANDIDATE'
--             ELSE 'AMBIGUOUS' END                                                AS verdict,
--        CASE WHEN count(rc.id) = 1
--             THEN abs(min(rc.harvest_date) - f.parsed_harvest_date) END          AS year_gap_days
-- FROM final f
-- LEFT JOIN public.grow_rooms  gr ON gr.room_number = f.room_no
-- LEFT JOIN public.room_cycles rc ON rc.room_id = gr.id
--                                AND rc.harvest_date IS NOT NULL
--                                AND f.parsed_harvest_date IS NOT NULL
--                                AND extract(month FROM rc.harvest_date) = extract(month FROM f.parsed_harvest_date)
--                                AND extract(day   FROM rc.harvest_date) = extract(day   FROM f.parsed_harvest_date)
-- GROUP BY f.id, f.name, f.created_at, f.is_active, f.parsed_harvest_date, f.room_no, gr.id, gr.room_name
-- ORDER BY verdict, f.name;
--
-- ASSUMPTION TO VERIFY BEFORE TRUSTING ANY LINK: that the `F<n>` in a batch name is
-- grow_rooms.room_number = n ("F1" may not mean room 1). Eyeball this mapping first:
--
-- SELECT room_number, room_name, current_phase FROM public.grow_rooms ORDER BY room_number;
--
-- Only the live cycles matter for this module (F1 dry, harvest 2026-10-01; F5 flower, harvest
-- 2026-10-29): those get linked by hand in the Phase 1 UI regardless of what the dry run says.
-- =====================================================================================

BEGIN;

ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS room_cycle_id uuid REFERENCES public.room_cycles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS harvest_date  date;

COMMENT ON COLUMN public.batches.room_cycle_id IS
  'Harvest & Trim: the room_cycle this batch was cut from. NULL for legacy / unlinked batches. '
  'Source of truth for provenance; the MMDD-F<room>-<STRAIN> name is only a display convention.';
COMMENT ON COLUMN public.batches.harvest_date IS
  'Harvest & Trim: the day this batch''s plants were cut. Not rewritten when Edit Cycle changes '
  'room_cycles.harvest_date (known acceptable drift).';

CREATE INDEX IF NOT EXISTS idx_batches_room_cycle
  ON public.batches (room_cycle_id) WHERE room_cycle_id IS NOT NULL;

COMMIT;
