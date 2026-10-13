-- Harvest & Trim, Phase 1: core tables + every state-transition function.
-- Plan: .context/harvest-trim-plan.md  (section 2.5 / 2.6, Revision 2: R2.2, R2.5, R2.6, R2.12-R2.15).
-- Where Revision 2 and the original sections disagree, Revision 2 wins.
--
-- WHAT THIS IS: the hanger -> dry -> trim -> reconcile chain for the harvest crew and the trim
-- manager. A reusable tag (`hangers`) carries one harvest's plants (`hanger_loads`) through a
-- state machine; custody of the load is issued to a trimmer in episodes (`trim_checkouts`); each
-- returned episode earns a pay line (`trim_pay_entries`); everything is audited (`trim_events`).
--
-- WHY THE STATE MACHINE LIVES IN POSTGRES: supabase-js has no multi-statement transaction, and a
-- check-in touches a checkout, a load and a pay entry and must be atomic, row-count-asserted and
-- audited in one place. So every transition is a SECURITY DEFINER function called via .rpc(); the
-- server actions are thin (auth, validate, call). Rules every function follows:
--   * The first LOCK taken is SELECT ... FOR UPDATE on the load row, before any mutable state is
--     read (functions that start from a checkout id first read its load_id - immutable - then lock
--     the load). create_load locks the HANGER row instead, since no load exists yet;
--     create_hangers / declare_batches are idempotent inserts (declare takes only a KEY SHARE on
--     the cycle so it cannot be deleted underneath). Concurrent scans of one tag therefore serialize.
--   * Every state-changing UPDATE carries the expected prior status in its WHERE, followed by
--     GET DIAGNOSTICS ... ROW_COUNT and a RAISE when it is not exactly 1 (the SPRO-131 defence,
--     built into the DB so an action cannot forget it).
--   * Errors are `RAISE EXCEPTION 'TRIM_E_<CODE>: message'` (SQLSTATE P0001). Codes in use:
--       NOT_FOUND, STATE, INVALID, FORBIDDEN, DUPLICATE_OPEN, ALREADY_OUT,
--       BATCH_REQUIRED (harvest weigh-in against an undeclared / inactive-cycle batch),
--       DUPLICATE_NAME (declare_batches name collision).
--     Raw constraint violations (23505 / 23514) are tripwires that should be unreachable through
--     these functions; actions should still map them to a generic failure, never to success.
--   * Exactly one trim_events row per call.
--   * The actor is ALWAYS the p_actor parameter (auth.session.userId, passed by the action), never
--     derived inside. fn_trim_void additionally looks up that actor's role from public.users to
--     enforce "partial is admin/management-only" (see below) - the role is re-read fresh from the DB, in the
--     same spirit as requireRole(), rather than trusting a flag from the caller.
--
-- WEIGHTS ARE PLAIN NET GRAMS (numeric(10,2)). The crew tares the empty hanger / bin, so there is
-- no gross/net split and no tare anywhere (plan section 2.2). Pounds exist only at the UI boundary
-- and in the pay formula.
--
-- PARTIAL RETURNS (R2.2). A hanger can be turned in unfinished: the weight and plant count left on
-- it are recorded and the hanger is reissued (same or different trimmer). The weight left on the
-- hanger is a FOURTH bucket in the same reconciliation equation:
--     variance_g   = issued_g - (flower_g + trim_g + stems_g + remaining_g)
--     processed_g  = issued_g - remaining_g
--     variance_pct = variance_g / processed_g * 100     <- denominator is processed_g, not issued_g
-- A complete return is simply remaining_g = 0. Load statuses:
--     hung, dried, checked_out, partial, returned, reconciled, void
--   dried    = dry weight known, NO returned episode exists (so dry-weight correction and the
--              hung/dried-only void are state rules, not subqueries)
--   partial  = at least one unfinished episode reconciled; remaining_g > 0 on the rack; reissuable
--   returned = newest episode came back FLAGGED and is unresolved (blocks reissue: its remaining
--              reading is the next episode's baseline, so a mis-weigh would otherwise surface as an
--              opposite-sign variance on the next trimmer)
--   A 'partial' load counts as OPEN for the one-open-load-per-hanger rule.
-- The remaining_g / remaining_plant_count columns on hanger_loads are a DENORMALISED CACHE written
-- ONLY by these functions. Invariant (asserted by supabase/tests/harvest_trim_smoke.sql): for every
-- load past 'hung', remaining_g = the remaining_g of its newest RETURNED episode, else dry_g.
--
-- Integrity guards that replaced the dropped one-returned-per-load index:
--   gapless episode sequence ..... UNIQUE(load_id, seq); seq = max+1 under the load row lock;
--                                  checkouts are never deleted
--   one holder at a time ......... partial unique (load_id) WHERE status = 'out'
--   at most one COMPLETE return .. partial unique (load_id) WHERE status='returned' AND return_kind='complete'
--   remaining non-increasing ..... CHECK remaining_g < issued_g (and > 0 when unfinished); issued_g
--                                  is copied from the load's remaining cache, so it holds by construction
--   plants non-increasing ........ CHECK remaining_plant_count <= issued_plant_count (NOT strict:
--                                  partial work on every plant is legitimate; the UI warns on equal)
--   a complete episode is last ... fn_trim_checkout refuses any status but hung / dried / partial
--   newest-episode-only mutation . enforced in correct_return / resolve_variance / reopen
--   one open load per hanger ..... partial unique (hanger_id) WHERE status NOT IN ('reconciled','void')
--
-- NO write-off (R2.12): abandoned remainders do not happen, so there is no writeOffRemainder and no
-- written_off_* column. The one escape hatch is fn_trim_void accepting `partial`, ADMIN OR MANAGEMENT
-- only (TRIM_ADMIN_ROLES; widened from the plan's literal "admin only" so a stuck batch - which blocks
-- trimmer pay - never waits on one of the two admins), with a mandatory reason, so a single stuck
-- hanger can never make a batch permanently unclosable.
--
-- NOT HERE (later phases): batches.trim_closed_*, fn_trim_close_batch / reopen_batch,
-- trim_payouts + fn_trim_approve_payout / reverse_payout (R2.14), realtime publication.
-- trim_pay_entries already carries the R2.14 status set (open -> ready -> approved) and has NO
-- paid_at / paid_by (paid-ness lives on the finance bill ledger); Phase 3 only adds `payout_id`.
--
-- SECURITY (matches every module in this app): RLS is enabled on every table with NO policies and
-- anon/authenticated are revoked, because every server action uses the service-role client and
-- authorization is enforced in application code (requireRole). Functions are SECURITY DEFINER with
-- search_path pinned, executable by service_role only.
--
-- `updated_at` is maintained by the EXISTING public.update_updated_at_column() BEFORE UPDATE
-- trigger function (the same one contacts / materials_inventory / product pricing use) rather than
-- a new one. The functions below also set updated_at explicitly; the trigger covers the actions'
-- direct writes (trim_staff, hangers, trim_settings).
--
-- Do NOT apply manually. Joshua applies via Supabase MCP after the PR merges, and only AFTER
-- 20261013091000 (this file references batches.room_cycle_id / harvest_date) - the preflight below
-- fails loudly if that order is wrong.

BEGIN;

-- ============================================================
-- 0. PREFLIGHT: fail loudly, before creating anything
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'preflight: public.update_updated_at_column() not found. It is expected to exist '
                    '(contacts / materials_inventory triggers use it); do not write a duplicate - '
                    'investigate with: SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'batches' AND column_name = 'room_cycle_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'batches' AND column_name = 'harvest_date') THEN
    RAISE EXCEPTION 'preflight: batches.room_cycle_id / harvest_date missing - apply 20261013091000 first';
  END IF;
  IF to_regclass('public.finance_vendors') IS NULL OR to_regclass('public.room_cycles') IS NULL
     OR to_regclass('public.strains') IS NULL THEN
    RAISE EXCEPTION 'preflight: finance_vendors / room_cycles / strains not found';
  END IF;
END $$;

-- ============================================================
-- 1. TABLES
-- ============================================================

-- ---- trim_settings (singleton) --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trim_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  variance_pct_threshold  numeric(5,2) NOT NULL DEFAULT 5.00
                            CHECK (variance_pct_threshold >= 0 AND variance_pct_threshold <= 100),
  variance_floor_g        numeric(8,2) NOT NULL DEFAULT 25.00 CHECK (variance_floor_g >= 0),
  updated_by              uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.trim_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
COMMENT ON TABLE public.trim_settings IS
  'Singleton. A return is flagged only when BOTH |variance_pct| > variance_pct_threshold AND '
  '|variance_g| > variance_floor_g. The floor suppresses scale noise on small amounts; the percent '
  'catches proportionally large misses. Symmetric (over-return flags too). The decision is made in '
  'lib/trim/variance.ts and passed to fn_trim_checkin; the threshold in force is snapshotted onto the checkout.';

-- ---- trim_staff (non-login workers) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trim_staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL CHECK (length(btrim(full_name)) > 0),
  display_name  text CHECK (display_name IS NULL OR length(btrim(display_name)) > 0),
  phone         text,
  email         text,
  start_date    date,
  pay_per_lb    numeric(8,2) NOT NULL CHECK (pay_per_lb >= 0 AND pay_per_lb <= 1000),
  -- R2.14: the finance_vendors row this person is paid through. Nullable in the column, but
  -- required before a payout can be approved (fn_trim_approve_payout raises TRIM_E_NO_VENDOR).
  vendor_id     uuid REFERENCES public.finance_vendors(id) ON DELETE RESTRICT,
  is_active     boolean NOT NULL DEFAULT true,
  notes         text,
  created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_trim_staff_active_name
  ON public.trim_staff (lower(btrim(full_name))) WHERE is_active;
COMMENT ON TABLE public.trim_staff IS
  'Non-login trimmers; deliberately NOT users rows (4-digit, globally unique, plaintext PINs). Never '
  'hard-deleted (checkouts FK RESTRICT); deactivate instead. No tax IDs / bank details by design - '
  'payment identity lives on the linked finance_vendors row.';

-- ---- hangers (reusable physical asset) -------------------------------------------------------
-- `code` is the barcode payload (Joshua's generator emits H1B-001 .. H1B-300). uuid PK + unique
-- code, NOT a text PK: a text PK copies the printed label into every load, checkout and event row,
-- so a reprint or renumber becomes a four-table cascade. Scan resolution is one indexed
-- `WHERE code = $1` either way. The code CHECK is deliberately loose so a second fleet (H2-001) is
-- a constant change in lib/trim/hanger-code.ts, not a migration.
-- label_seq is the numeric tail of the code, kept as a real integer for ordering. It is CHECKed to
-- equal that tail, which is also the DB-level tripwire for the lpad() truncation bug: if a seeder
-- ever turns 1000 into 'H1B-100', label_seq (1000) disagrees with the code and the row is rejected.
-- Uniqueness is (prefix, label_seq), not label_seq alone, so a second fleet may reuse 001..;
-- and 'H1B-0001' cannot coexist with 'H1B-001' (same tag number, different width).
CREATE TABLE IF NOT EXISTS public.hangers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]+-[0-9]{3,6}$'),
  label_seq   integer NOT NULL CHECK (label_seq >= 1),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','lost')),
  notes       text,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hangers_seq_matches_code CHECK (label_seq = substring(code from '([0-9]+)$')::integer)
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_hangers_prefix_seq
  ON public.hangers ((regexp_replace(code, '[0-9]+$', '')), label_seq);
COMMENT ON TABLE public.hangers IS
  'Reusable physical hanger tag. Holds only what belongs to the metal (id, code, label_seq, status); '
  'plants, weights and trimmer belong to a harvest and live on hanger_loads. No tare column: the '
  'crew tares the hanger, so every recorded weight is already net.';

-- ---- hanger_loads (one harvest's plants on one hanger) ---------------------------------------
CREATE TABLE IF NOT EXISTS public.hanger_loads (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hanger_id              uuid NOT NULL REFERENCES public.hangers(id) ON DELETE RESTRICT,
  batch_id               uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  status                 text NOT NULL DEFAULT 'hung'
                           CHECK (status IN ('hung','dried','checked_out','partial','returned','reconciled','void')),
  source                 text NOT NULL DEFAULT 'harvest' CHECK (source IN ('harvest','trim_station')),
  plant_count            integer CHECK (plant_count IS NULL OR (plant_count BETWEEN 1 AND 500)),
  wet_g                  numeric(10,2) CHECK (wet_g IS NULL OR (wet_g > 0 AND wet_g <= 200000)),
  wet_recorded_at        timestamptz,
  wet_recorded_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  dry_g                  numeric(10,2) CHECK (dry_g IS NULL OR (dry_g > 0 AND dry_g <= 200000)),
  dry_recorded_at        timestamptz,
  dry_recorded_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- DENORMALISED CACHE, written only by fn_trim_*: what is still on the rack as of the newest
  -- returned episode (dry_g when nothing has been returned). See header.
  remaining_g            numeric(10,2) CHECK (remaining_g IS NULL OR (remaining_g >= 0 AND remaining_g <= 200000)),
  remaining_plant_count  integer CHECK (remaining_plant_count IS NULL OR (remaining_plant_count BETWEEN 0 AND 500)),
  reconciled_at          timestamptz,
  reconciled_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  voided_at              timestamptz,
  voided_by              uuid REFERENCES public.users(id) ON DELETE SET NULL,
  void_reason            text,
  created_by             uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loads_wet_pair      CHECK ((wet_g IS NULL) = (wet_recorded_at IS NULL)),
  CONSTRAINT loads_dry_pair      CHECK ((dry_g IS NULL) = (dry_recorded_at IS NULL)),
  CONSTRAINT loads_hung_has_wet  CHECK (status <> 'hung' OR wet_g IS NOT NULL),
  CONSTRAINT loads_post_dry      CHECK (status NOT IN ('dried','checked_out','partial','returned','reconciled') OR dry_g IS NOT NULL),
  CONSTRAINT loads_remaining_set CHECK (status NOT IN ('dried','checked_out','partial','returned','reconciled') OR remaining_g IS NOT NULL),
  CONSTRAINT loads_remaining_le_dry CHECK (remaining_g IS NULL OR (dry_g IS NOT NULL AND remaining_g <= dry_g)),
  CONSTRAINT loads_remaining_plants_le CHECK (remaining_plant_count IS NULL OR plant_count IS NULL OR remaining_plant_count <= plant_count),
  -- NB: coalesce()/IS NOT DISTINCT FROM below on purpose - a bare `remaining_plant_count >= 1` is NULL
  -- (and a CHECK passes on NULL) when the cache is missing.
  CONSTRAINT loads_partial       CHECK (status <> 'partial' OR (coalesce(remaining_g, 0) > 0 AND coalesce(remaining_plant_count, 0) >= 1)),
  CONSTRAINT loads_reconciled    CHECK (status <> 'reconciled' OR
                                    (reconciled_at IS NOT NULL AND remaining_g IS NOT DISTINCT FROM 0 AND remaining_plant_count IS NOT DISTINCT FROM 0)),
  CONSTRAINT loads_void          CHECK (status <> 'void' OR (voided_at IS NOT NULL AND length(btrim(coalesce(void_reason,''))) >= 3))
);
-- INVARIANT: one open load per hanger ('partial' is open). Also the access path for "tag -> its open load".
CREATE UNIQUE INDEX IF NOT EXISTS uidx_hanger_loads_one_open_per_hanger
  ON public.hanger_loads (hanger_id) WHERE status NOT IN ('reconciled','void');
-- batch page / batch-close gate: loads of a batch by status
CREATE INDEX IF NOT EXISTS idx_hanger_loads_batch ON public.hanger_loads (batch_id, status);
-- board: every open load by status (small partial index; the closed history is the bulk of the table)
CREATE INDEX IF NOT EXISTS idx_hanger_loads_open  ON public.hanger_loads (status) WHERE status NOT IN ('reconciled','void');
-- lookup screen: every load a tag has ever carried, newest first
CREATE INDEX IF NOT EXISTS idx_hanger_loads_hanger ON public.hanger_loads (hanger_id, created_at DESC);

-- ---- trim_checkouts (custody episodes + returned weights + variance) -------------------------
CREATE TABLE IF NOT EXISTS public.trim_checkouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id               uuid NOT NULL REFERENCES public.hanger_loads(id) ON DELETE RESTRICT,
  seq                   integer NOT NULL CHECK (seq >= 1),
  trimmer_id            uuid NOT NULL REFERENCES public.trim_staff(id) ON DELETE RESTRICT,
  trimmer_name          text NOT NULL,
  status                text NOT NULL DEFAULT 'out' CHECK (status IN ('out','returned','released')),
  issued_g              numeric(10,2) NOT NULL CHECK (issued_g > 0 AND issued_g <= 200000),
  issued_plant_count    integer CHECK (issued_plant_count IS NULL OR (issued_plant_count BETWEEN 1 AND 500)),
  rate_per_lb_applied   numeric(8,2) NOT NULL CHECK (rate_per_lb_applied >= 0 AND rate_per_lb_applied <= 1000),
  checked_out_at        timestamptz NOT NULL DEFAULT now(),
  checked_out_by        uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  released_at           timestamptz,
  released_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  release_reason        text,
  returned_at           timestamptz,
  returned_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  return_kind           text CHECK (return_kind IS NULL OR return_kind IN ('complete','unfinished')),
  flower_g              numeric(10,2) CHECK (flower_g IS NULL OR (flower_g >= 0 AND flower_g <= 200000)),
  trim_g                numeric(10,2) CHECK (trim_g   IS NULL OR (trim_g   >= 0 AND trim_g   <= 200000)),
  stems_g               numeric(10,2) CHECK (stems_g  IS NULL OR (stems_g  >= 0 AND stems_g  <= 200000)),
  -- grams / plants still on the hanger after this episode: 0 / 0 for a complete return
  remaining_g           numeric(10,2) CHECK (remaining_g IS NULL OR (remaining_g >= 0 AND remaining_g <= 200000)),
  remaining_plant_count integer CHECK (remaining_plant_count IS NULL OR (remaining_plant_count BETWEEN 0 AND 500)),
  -- Derived, never written by TS. Generated columns cannot reference each other, so each
  -- expression is spelled out in full. NULL until the episode is returned.
  returned_total_g      numeric(10,2) GENERATED ALWAYS AS (flower_g + trim_g + stems_g) STORED,
  processed_g           numeric(10,2) GENERATED ALWAYS AS (issued_g - remaining_g) STORED,
  plants_finished       integer       GENERATED ALWAYS AS (issued_plant_count - remaining_plant_count) STORED,
  variance_g            numeric(10,2) GENERATED ALWAYS AS
                          (issued_g - (flower_g + trim_g + stems_g + remaining_g)) STORED,
  -- processed_g is the denominator (an episode that trimmed 300 g of 3000 g must not hide a 100 g
  -- loss as 3%). nullif() keeps a (CHECK-rejected) remaining = issued row from dying on a
  -- division-by-zero before the CHECK gets to name the real problem. Unconstrained numeric (scale 3
  -- via round): with a tiny processed_g a fat-fingered weight would overflow the numeric(7,3) of
  -- the original draft and surface as an opaque 22003 on check-in instead of a flagged variance.
  variance_pct          numeric GENERATED ALWAYS AS
                          (round((issued_g - (flower_g + trim_g + stems_g + remaining_g))
                                 / nullif(issued_g - remaining_g, 0) * 100, 3)) STORED,
  flag_pct_applied      numeric(5,2),
  flag_floor_g_applied  numeric(8,2),
  variance_status       text CHECK (variance_status IN ('ok','flagged','accepted')),
  variance_reason       text,
  variance_accepted_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  variance_accepted_at  timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT co_out_clean CHECK (status <> 'out' OR
    (flower_g IS NULL AND trim_g IS NULL AND stems_g IS NULL AND remaining_g IS NULL
     AND remaining_plant_count IS NULL AND return_kind IS NULL AND returned_at IS NULL
     AND variance_status IS NULL)),
  CONSTRAINT co_returned_complete CHECK (status <> 'returned' OR
    (flower_g IS NOT NULL AND trim_g IS NOT NULL AND stems_g IS NOT NULL
     AND remaining_g IS NOT NULL AND remaining_plant_count IS NOT NULL AND return_kind IS NOT NULL
     AND returned_at IS NOT NULL AND variance_status IS NOT NULL
     AND flag_pct_applied IS NOT NULL AND flag_floor_g_applied IS NOT NULL)),
  CONSTRAINT co_released CHECK (status <> 'released' OR
    (released_at IS NOT NULL AND length(btrim(coalesce(release_reason,''))) >= 3
     AND flower_g IS NULL AND trim_g IS NULL AND stems_g IS NULL AND remaining_g IS NULL
     AND remaining_plant_count IS NULL AND return_kind IS NULL AND variance_status IS NULL)),
  CONSTRAINT co_kind_complete CHECK (return_kind IS DISTINCT FROM 'complete' OR
    (remaining_g IS NOT DISTINCT FROM 0 AND remaining_plant_count IS NOT DISTINCT FROM 0)),
  CONSTRAINT co_kind_unfinished CHECK (return_kind IS DISTINCT FROM 'unfinished' OR
    (coalesce(remaining_g, 0) > 0 AND coalesce(remaining_plant_count, 0) >= 1)),
  -- remaining is strictly below what was issued (monotonic by construction, enforced here too)
  CONSTRAINT co_remaining_lt_issued CHECK (remaining_g IS NULL OR remaining_g < issued_g),
  -- NOT strict: partial work on every plant is legitimate
  CONSTRAINT co_plants_nonincreasing CHECK
    (remaining_plant_count IS NULL OR issued_plant_count IS NULL OR remaining_plant_count <= issued_plant_count),
  CONSTRAINT co_accepted CHECK (variance_status IS DISTINCT FROM 'accepted' OR
    (variance_accepted_by IS NOT NULL AND length(btrim(coalesce(variance_reason,''))) >= 3)),
  -- Tripwire: TS decides 'ok'; the DB refuses an 'ok' its own snapshot says is out of threshold.
  CONSTRAINT co_ok_within_threshold CHECK (variance_status IS DISTINCT FROM 'ok' OR
    (abs(variance_g) <= flag_floor_g_applied OR abs(variance_pct) <= flag_pct_applied))
);
-- INVARIANT: a load is held by at most one person at a time (packaging_claims precedent)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_trim_checkouts_one_out_per_load
  ON public.trim_checkouts (load_id) WHERE status = 'out';
-- INVARIANT: at most one COMPLETE return per load (partial returns make N unfinished episodes legal)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_trim_checkouts_one_complete_per_load
  ON public.trim_checkouts (load_id) WHERE status = 'returned' AND return_kind = 'complete';
-- INVARIANT: gapless-by-construction episode numbering; also the "episodes of a load" access path
CREATE UNIQUE INDEX IF NOT EXISTS uidx_trim_checkouts_seq ON public.trim_checkouts (load_id, seq);
-- "who holds what right now" (per-trimmer outstanding)
CREATE INDEX IF NOT EXISTS idx_trim_checkouts_trimmer_out ON public.trim_checkouts (trimmer_id) WHERE status = 'out';
-- trimmer performance over a date range
CREATE INDEX IF NOT EXISTS idx_trim_checkouts_trimmer ON public.trim_checkouts (trimmer_id, checked_out_at DESC);

-- ---- trim_pay_entries (ledger; one per returned episode that is ok / accepted) ---------------
-- Status workflow (R2.14): open (created at check-in) -> ready (batch closed, Phase 3) -> approved
-- (per-trimmer payout approved and a finance bill raised, Phase 3). Payment itself is NOT tracked
-- here: it lives on finance_bills / finance_bill_payments. Phase 3 adds payout_id.
CREATE TABLE IF NOT EXISTS public.trim_pay_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id          uuid NOT NULL UNIQUE REFERENCES public.trim_checkouts(id) ON DELETE RESTRICT,
  batch_id             uuid NOT NULL REFERENCES public.batches(id)    ON DELETE RESTRICT,
  trimmer_id           uuid NOT NULL REFERENCES public.trim_staff(id) ON DELETE RESTRICT,
  flower_g             numeric(10,2) NOT NULL CHECK (flower_g >= 0),
  rate_per_lb_applied  numeric(8,2)  NOT NULL CHECK (rate_per_lb_applied >= 0 AND rate_per_lb_applied <= 1000),
  amount               numeric(10,2) NOT NULL CHECK (amount >= 0),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ready','approved')),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Tripwire against TS/SQL drift. 453.59237 = lib/units.ts GRAMS_PER_LB.
  CONSTRAINT pay_amount_matches CHECK (abs(amount - (flower_g / 453.59237) * rate_per_lb_applied) <= 0.0051)
);
-- pay by trimmer within a batch (the review screen, the close-batch sums)
CREATE INDEX IF NOT EXISTS idx_trim_pay_batch   ON public.trim_pay_entries (batch_id, trimmer_id);
-- per-trimmer register by status
CREATE INDEX IF NOT EXISTS idx_trim_pay_trimmer ON public.trim_pay_entries (trimmer_id, status);

-- ---- trim_events (append-only audit) ---------------------------------------------------------
-- The FK columns are ON DELETE SET NULL so that deleting a declared, still-empty batch (or a user)
-- does not fail on its own audit rows; the immutability trigger permits exactly that cascade and
-- nothing else. Payloads therefore carry human-readable names (batch name, hanger code) so an
-- event stays meaningful after its reference has been nulled.
CREATE TABLE IF NOT EXISTS public.trim_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_type     text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  hanger_id      uuid REFERENCES public.hangers(id)        ON DELETE SET NULL,
  load_id        uuid REFERENCES public.hanger_loads(id)   ON DELETE SET NULL,
  checkout_id    uuid REFERENCES public.trim_checkouts(id) ON DELETE SET NULL,
  batch_id       uuid REFERENCES public.batches(id)        ON DELETE SET NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- load history
CREATE INDEX IF NOT EXISTS idx_trim_events_load   ON public.trim_events (load_id, occurred_at);
-- hanger history ("everything this tag has ever done"), newest first
CREATE INDEX IF NOT EXISTS idx_trim_events_hanger ON public.trim_events (hanger_id, occurred_at DESC);
-- batch audit
CREATE INDEX IF NOT EXISTS idx_trim_events_batch  ON public.trim_events (batch_id, occurred_at);
COMMENT ON TABLE public.trim_events IS
  'Append-only audit log. event_type values written by the Phase 1 functions: hangers_created, '
  'batches_declared, load_created, dry_recorded, dry_corrected, wet_corrected, checked_out, released, '
  'checked_in, return_corrected, variance_resolved, reopened, voided. Actions add their own for '
  'direct writes (e.g. trim_staff_rate_changed). UPDATE / DELETE / TRUNCATE are rejected by trigger.';

CREATE OR REPLACE FUNCTION public.fn_trim_events_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_keys text[] := ARRAY['actor_user_id','hanger_id','load_id','checkout_id','batch_id'];
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'trim_events is append-only';
  END IF;
  -- UPDATE: the single permitted mutation is the ON DELETE SET NULL cascade nulling a reference
  -- column. pg_trigger_depth() > 1 means we are inside the FK action's own trigger, not a user UPDATE.
  IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - v_keys) = (to_jsonb(OLD) - v_keys)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
     AND (NEW.hanger_id     IS NULL OR NEW.hanger_id     = OLD.hanger_id)
     AND (NEW.load_id       IS NULL OR NEW.load_id       = OLD.load_id)
     AND (NEW.checkout_id   IS NULL OR NEW.checkout_id   = OLD.checkout_id)
     AND (NEW.batch_id      IS NULL OR NEW.batch_id      = OLD.batch_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'trim_events is append-only';
END $$;

DROP TRIGGER IF EXISTS trg_trim_events_immutable ON public.trim_events;
CREATE TRIGGER trg_trim_events_immutable BEFORE UPDATE OR DELETE ON public.trim_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_trim_events_immutable();
DROP TRIGGER IF EXISTS trg_trim_events_no_truncate ON public.trim_events;
CREATE TRIGGER trg_trim_events_no_truncate BEFORE TRUNCATE ON public.trim_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_trim_events_immutable();

-- ---- updated_at: reuse the existing trigger function ------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trim_settings','trim_staff','hangers','hanger_loads','trim_checkouts','trim_pay_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I '
                   'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- ---- RLS lockdown: no policies, service-role only ---------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trim_settings','trim_staff','hangers','hanger_loads',
                           'trim_checkouts','trim_pay_entries','trim_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ============================================================
-- 2. INTERNAL HELPERS (not granted to anyone; called only from the definer functions below)
-- ============================================================

-- One audit row. Centralised so every function writes the same shape.
CREATE OR REPLACE FUNCTION public.fn_trim_log_event(
  p_actor uuid, p_type text, p_hanger_id uuid, p_load_id uuid, p_checkout_id uuid,
  p_batch_id uuid, p_payload jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO trim_events (actor_user_id, event_type, hanger_id, load_id, checkout_id, batch_id, payload)
  VALUES (p_actor, p_type, p_hanger_id, p_load_id, p_checkout_id, p_batch_id, coalesce(p_payload, '{}'::jsonb));
END $$;

-- Argument validation shared by fn_trim_checkin and fn_trim_correct_return, so the two cannot drift.
-- Friendly TRIM_E_INVALID messages here; the table CHECKs remain the backstop.
CREATE OR REPLACE FUNCTION public.fn_trim_assert_return_args(
  p_return_kind text, p_flower_g numeric, p_trim_g numeric, p_stems_g numeric,
  p_remaining_g numeric, p_remaining_plants integer,
  p_issued_g numeric, p_issued_plants integer,
  p_variance_status text, p_flag_pct numeric, p_flag_floor_g numeric, p_pay_amount numeric
) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_return_kind IS NULL OR p_return_kind NOT IN ('complete','unfinished') THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: return kind must be complete or unfinished';
  END IF;
  IF p_variance_status IS NULL OR p_variance_status NOT IN ('ok','flagged') THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: variance status must be ok or flagged';
  END IF;
  IF p_flower_g IS NULL OR p_trim_g IS NULL OR p_stems_g IS NULL
     OR p_flower_g < 0 OR p_trim_g < 0 OR p_stems_g < 0
     OR p_flower_g > 200000 OR p_trim_g > 200000 OR p_stems_g > 200000 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: flower, trim and stems weights are required and must be between 0 and 200000 g';
  END IF;
  IF p_flag_pct IS NULL OR p_flag_floor_g IS NULL OR p_flag_pct < 0 OR p_flag_floor_g < 0 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: variance threshold snapshot is required';
  END IF;
  IF p_variance_status = 'ok' AND (p_pay_amount IS NULL OR p_pay_amount < 0) THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: pay amount is required for a return within threshold';
  END IF;
  IF p_return_kind = 'complete' THEN
    IF coalesce(p_remaining_g, 0) <> 0 OR coalesce(p_remaining_plants, 0) <> 0 THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: a complete return cannot have remaining weight or plants';
    END IF;
  ELSE
    IF p_remaining_g IS NULL OR p_remaining_g <= 0 THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: an unfinished return needs the weight of the remaining plants (> 0)';
    END IF;
    IF p_remaining_g >= p_issued_g THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: remaining weight (% g) must be less than the weight issued (% g)',
        p_remaining_g, p_issued_g;
    END IF;
    IF p_remaining_plants IS NULL OR p_remaining_plants < 1 THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: an unfinished return needs the number of plants left (>= 1)';
    END IF;
    IF p_issued_plants IS NOT NULL AND p_remaining_plants > p_issued_plants THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: plants left (%) cannot exceed plants issued (%)',
        p_remaining_plants, p_issued_plants;
    END IF;
  END IF;
END $$;

-- ============================================================
-- 3. TRANSITION FUNCTIONS
-- ============================================================

-- ---- fn_create_hangers: the "next N sequential IDs" seeder ------------------------------------
-- generate_series + ON CONFLICT (code) DO NOTHING (Joshua's idempotent pattern): re-running 1..300
-- is a no-op, 301..360 extends the fleet. No hanger_code_seq sequence: a sequence cannot match a
-- pre-printed run and burns numbers on rollback. The physical tags are the source of truth; the
-- primary route in is importHangers (a plain insert from the action), this is the convenience path.
--
-- THE lpad TRAP: lpad('1000', 3, '0') returns '100' - it TRUNCATES. Seeding 1000 with 3 digits
-- would silently collide with hanger 100 and ON CONFLICT DO NOTHING would hide it. So this RAISES
-- when any number in the range exceeds the digit width; and hangers_seq_matches_code is the
-- table-level backstop.
CREATE OR REPLACE FUNCTION public.fn_create_hangers(
  p_prefix text, p_start integer, p_count integer, p_digits integer, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_last     bigint;
  v_inserted integer;
  v_codes    text[];
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF p_prefix IS NULL OR p_prefix !~ '^[A-Z0-9]+-$' THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: prefix must look like H1B- (got %)', p_prefix;
  END IF;
  IF p_digits IS NULL OR p_digits NOT BETWEEN 3 AND 6 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: digits must be between 3 and 6 (got %)', p_digits;
  END IF;
  IF p_start IS NULL OR p_start < 1 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: start must be >= 1 (got %)', p_start;
  END IF;
  IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: count must be between 1 and 1000 (got %)', p_count;
  END IF;
  v_last := p_start::bigint + p_count - 1;
  IF v_last > power(10, p_digits)::bigint - 1 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: number % does not fit in % digits (max %); lpad would silently truncate it',
      v_last, p_digits, power(10, p_digits)::bigint - 1;
  END IF;

  BEGIN
    WITH ins AS (
      INSERT INTO hangers (code, label_seq, created_by)
      SELECT p_prefix || lpad(n::text, p_digits, '0'), n, p_actor
        FROM generate_series(p_start, p_start + p_count - 1) AS n
      ON CONFLICT (code) DO NOTHING
      RETURNING code
    )
    SELECT count(*)::integer, coalesce(array_agg(code ORDER BY code), ARRAY[]::text[])
      INTO v_inserted, v_codes
      FROM ins;
  EXCEPTION WHEN unique_violation THEN
    -- code differs but (prefix, label_seq) is taken: the same tag number already exists at another width
    RAISE EXCEPTION 'TRIM_E_INVALID: a hanger with the same prefix and number already exists at a different digit width (e.g. H1B-001 vs H1B-0001)';
  END;

  PERFORM fn_trim_log_event(p_actor, 'hangers_created', NULL, NULL, NULL, NULL,
    jsonb_build_object('prefix', p_prefix, 'start', p_start, 'count', p_count, 'digits', p_digits,
                       'inserted', v_inserted, 'skipped', p_count - v_inserted));
  RETURN jsonb_build_object('inserted', v_inserted, 'skipped', p_count - v_inserted, 'codes', to_jsonb(v_codes));
END $$;

-- ---- fn_trim_declare_batches (R2.5): batches declared at the flower -> harvest advance --------
-- p_batches = [{"strain_id": uuid, "name": text, "harvest_date": "YYYY-MM-DD" (optional)}, ...]
-- Atomic (all or nothing) and idempotent per cycle: an element whose name already exists on THIS
-- cycle for the SAME strain is skipped; the same name on a different cycle / strain raises
-- DUPLICATE_NAME. Creates batches is_active = false (nothing in this module ever sets true) and
-- writes ONLY to batches (+ one trim_events row): never room_cycles / grow_rooms. harvest_date
-- defaults to room_cycles.harvest_date, read-only.
CREATE OR REPLACE FUNCTION public.fn_trim_declare_batches(
  p_cycle_id uuid, p_batches jsonb, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle    public.room_cycles;
  v_el       jsonb;
  v_name     text;
  v_strain   uuid;
  v_hd       date;
  v_existing public.batches;
  v_new      public.batches;
  v_n        integer;
  v_seen     text[] := ARRAY[]::text[];
  v_created  jsonb  := '[]'::jsonb;
  v_skipped  jsonb  := '[]'::jsonb;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF p_batches IS NULL OR jsonb_typeof(p_batches) <> 'array'
     OR jsonb_array_length(p_batches) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: batches must be a JSON array of 1 to 50 elements';
  END IF;

  -- KEY SHARE: stops the cycle being deleted under us without blocking a concurrent stage advance
  SELECT * INTO v_cycle FROM room_cycles WHERE id = p_cycle_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: cycle %', p_cycle_id; END IF;
  IF v_cycle.status <> 'active' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: cycle is % - batches can only be declared on an active cycle', v_cycle.status;
  END IF;

  FOR v_el IN SELECT value FROM jsonb_array_elements(p_batches) LOOP
    IF jsonb_typeof(v_el) <> 'object' THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: each batch must be an object';
    END IF;
    v_name := btrim(coalesce(v_el->>'name', ''));
    IF length(v_name) NOT BETWEEN 1 AND 64 THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: batch name must be 1 to 64 characters';
    END IF;
    BEGIN
      v_strain := (v_el->>'strain_id')::uuid;
      v_hd     := coalesce((v_el->>'harvest_date')::date, v_cycle.harvest_date);
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: bad strain_id or harvest_date for batch %', v_name;
    END;
    IF v_strain IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: strain_id is required for batch %', v_name; END IF;
    IF lower(v_name) = ANY (v_seen) THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: batch name % appears twice in the request', v_name;
    END IF;
    v_seen := v_seen || lower(v_name);
    IF NOT EXISTS (SELECT 1 FROM strains WHERE id = v_strain) THEN
      RAISE EXCEPTION 'TRIM_E_NOT_FOUND: strain % (batch %)', v_strain, v_name;
    END IF;

    -- batches.name is UNIQUE (case-sensitive) but the app dedupes case-insensitively, so look both ways
    SELECT * INTO v_existing FROM batches
     WHERE lower(name) = lower(v_name) ORDER BY (name = v_name) DESC LIMIT 1;
    IF FOUND THEN
      IF v_existing.name = v_name AND v_existing.room_cycle_id = p_cycle_id AND v_existing.strain_id = v_strain THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_existing.id, 'name', v_existing.name,
                       'strain_id', v_existing.strain_id, 'harvest_date', v_existing.harvest_date);
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'TRIM_E_DUPLICATE_NAME: a batch named % already exists (different cycle or strain)', v_existing.name;
    END IF;

    INSERT INTO batches (name, strain_id, is_active, room_cycle_id, harvest_date)
    VALUES (v_name, v_strain, false, p_cycle_id, v_hd)
    ON CONFLICT (name) DO NOTHING
    RETURNING * INTO v_new;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'TRIM_E_DUPLICATE_NAME: batch % was created concurrently - retry', v_name;
    END IF;
    v_created := v_created || jsonb_build_object('id', v_new.id, 'name', v_new.name,
                   'strain_id', v_new.strain_id, 'harvest_date', v_new.harvest_date);
  END LOOP;

  PERFORM fn_trim_log_event(p_actor, 'batches_declared', NULL, NULL, NULL, NULL,
    jsonb_build_object('cycle_id', p_cycle_id, 'created', v_created, 'skipped', v_skipped));
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END $$;

-- ---- fn_trim_create_load: transitions 1 / 1b ---------------------------------------------------
-- source 'harvest'      : wet weight REQUIRED, dry must be NULL           -> status 'hung'
-- source 'trim_station' : late entry for hangers already drying on paper;
--                         dry weight REQUIRED, wet optional               -> status 'dried'
-- A harvest weigh-in requires the batch to be declared (room_cycle_id set) on an ACTIVE cycle
-- (R2.5 wet-weight gate, layer 3); late entry is exempt. Locks the HANGER row (no load exists yet)
-- so two stations scanning the same new tag serialize. Rejects a retired / lost hanger.
CREATE OR REPLACE FUNCTION public.fn_trim_create_load(
  p_hanger_id uuid, p_batch_id uuid, p_plant_count integer, p_wet_g numeric, p_dry_g numeric,
  p_source text, p_actor uuid
) RETURNS public.hanger_loads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hanger public.hangers;
  v_batch  public.batches;
  v_cycle_status text;
  v_open   public.hanger_loads;
  v_load   public.hanger_loads;
  v_status text;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  IF p_source IS NULL OR p_source NOT IN ('harvest','trim_station') THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: source must be harvest or trim_station';
  END IF;

  SELECT * INTO v_hanger FROM hangers WHERE id = p_hanger_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: hanger %', p_hanger_id; END IF;
  IF v_hanger.status <> 'active' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: hanger % is %', v_hanger.code, v_hanger.status;
  END IF;

  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: batch %', p_batch_id; END IF;

  IF p_plant_count IS NOT NULL AND p_plant_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: plant count must be between 1 and 500';
  END IF;
  IF p_wet_g IS NOT NULL AND (p_wet_g <= 0 OR p_wet_g > 200000) THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: wet weight must be > 0 and <= 200000 g';
  END IF;
  IF p_dry_g IS NOT NULL AND (p_dry_g <= 0 OR p_dry_g > 200000) THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: dry weight must be > 0 and <= 200000 g';
  END IF;

  IF p_source = 'harvest' THEN
    IF p_wet_g IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: a harvest weigh-in needs a wet weight'; END IF;
    IF p_dry_g IS NOT NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: a harvest weigh-in cannot carry a dry weight'; END IF;
    IF v_batch.room_cycle_id IS NULL THEN
      RAISE EXCEPTION 'TRIM_E_BATCH_REQUIRED: batch % is not linked to a cycle - declare batches first', v_batch.name;
    END IF;
    SELECT status INTO v_cycle_status FROM room_cycles WHERE id = v_batch.room_cycle_id;
    IF v_cycle_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'TRIM_E_BATCH_REQUIRED: the cycle for batch % is %, not active', v_batch.name, coalesce(v_cycle_status, 'missing');
    END IF;
    v_status := 'hung';
  ELSE
    IF p_dry_g IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: a late-entry load needs a dry weight'; END IF;
    v_status := 'dried';
  END IF;

  SELECT * INTO v_open FROM hanger_loads
   WHERE hanger_id = p_hanger_id AND status NOT IN ('reconciled','void');
  IF FOUND THEN
    RAISE EXCEPTION 'TRIM_E_DUPLICATE_OPEN: hanger % still has an open load (status %)', v_hanger.code, v_open.status;
  END IF;

  INSERT INTO hanger_loads (
    hanger_id, batch_id, status, source, plant_count,
    wet_g, wet_recorded_at, wet_recorded_by,
    dry_g, dry_recorded_at, dry_recorded_by,
    remaining_g, remaining_plant_count, created_by)
  VALUES (
    p_hanger_id, p_batch_id, v_status, p_source, p_plant_count,
    p_wet_g, CASE WHEN p_wet_g IS NOT NULL THEN now() END, CASE WHEN p_wet_g IS NOT NULL THEN p_actor END,
    p_dry_g, CASE WHEN p_dry_g IS NOT NULL THEN now() END, CASE WHEN p_dry_g IS NOT NULL THEN p_actor END,
    p_dry_g, p_plant_count, p_actor)
  RETURNING * INTO v_load;

  PERFORM fn_trim_log_event(p_actor, 'load_created', v_hanger.id, v_load.id, NULL, v_load.batch_id,
    jsonb_build_object('to_status', v_status, 'source', p_source, 'hanger_code', v_hanger.code,
                       'batch_name', v_batch.name, 'plant_count', p_plant_count,
                       'wet_g', p_wet_g, 'dry_g', p_dry_g));
  RETURN v_load;
END $$;

-- ---- fn_trim_record_dry: transitions 2 / 3 -----------------------------------------------------
-- hung -> dried, or an in-place correction while already dried. 'dried' strictly means "no
-- returned episode exists", so a correction can never contradict episode history. Re-seeds the
-- remaining cache (remaining = dry for a load with no returned episode).
CREATE OR REPLACE FUNCTION public.fn_trim_record_dry(
  p_load_id uuid, p_dry_g numeric, p_actor uuid
) RETURNS public.hanger_loads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load public.hanger_loads;
  v_new  public.hanger_loads;
  v_n    integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: load %', p_load_id; END IF;
  IF v_load.status NOT IN ('hung','dried') THEN
    RAISE EXCEPTION 'TRIM_E_STATE: dry weight can only be recorded or corrected while the load is hung or dried (is %)', v_load.status;
  END IF;
  IF p_dry_g IS NULL OR p_dry_g <= 0 OR p_dry_g > 200000 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: dry weight must be > 0 and <= 200000 g';
  END IF;

  UPDATE hanger_loads
     SET status = 'dried', dry_g = p_dry_g, dry_recorded_at = now(), dry_recorded_by = p_actor,
         remaining_g = p_dry_g, remaining_plant_count = plant_count, updated_at = now()
   WHERE id = v_load.id AND status = v_load.status
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load % changed state while recording dry weight', v_load.id; END IF;

  PERFORM fn_trim_log_event(p_actor,
    CASE WHEN v_load.status = 'hung' THEN 'dry_recorded' ELSE 'dry_corrected' END,
    v_load.hanger_id, v_load.id, NULL, v_load.batch_id,
    jsonb_build_object('from_status', v_load.status, 'to_status', 'dried',
                       'old_dry_g', v_load.dry_g, 'new_dry_g', p_dry_g));
  RETURN v_new;
END $$;

-- ---- fn_trim_correct_wet ----------------------------------------------------------------------
-- Allowed while hung or dried (i.e. before any episode has been returned) - the only time the
-- plant count may change without contradicting episode history. Also the late wet entry for a
-- trim_station load. A NULL argument leaves that field unchanged; at least one must be supplied.
CREATE OR REPLACE FUNCTION public.fn_trim_correct_wet(
  p_load_id uuid, p_wet_g numeric, p_plant_count integer, p_actor uuid
) RETURNS public.hanger_loads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load public.hanger_loads;
  v_new  public.hanger_loads;
  v_n    integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: load %', p_load_id; END IF;
  IF v_load.status NOT IN ('hung','dried') THEN
    RAISE EXCEPTION 'TRIM_E_STATE: wet weight / plant count can only be corrected while the load is hung or dried (is %)', v_load.status;
  END IF;
  IF p_wet_g IS NULL AND p_plant_count IS NULL THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: supply a wet weight and/or a plant count';
  END IF;
  IF p_wet_g IS NOT NULL AND (p_wet_g <= 0 OR p_wet_g > 200000) THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: wet weight must be > 0 and <= 200000 g';
  END IF;
  IF p_plant_count IS NOT NULL AND p_plant_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: plant count must be between 1 and 500';
  END IF;

  UPDATE hanger_loads
     SET wet_g           = coalesce(p_wet_g, wet_g),
         wet_recorded_at = CASE WHEN p_wet_g IS NOT NULL THEN now() ELSE wet_recorded_at END,
         wet_recorded_by = CASE WHEN p_wet_g IS NOT NULL THEN p_actor ELSE wet_recorded_by END,
         plant_count     = coalesce(p_plant_count, plant_count),
         -- no returned episode yet, so the cache simply tracks the plant count
         remaining_plant_count = coalesce(p_plant_count, plant_count),
         updated_at      = now()
   WHERE id = v_load.id AND status = v_load.status
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load % changed state while correcting wet weight', v_load.id; END IF;

  PERFORM fn_trim_log_event(p_actor, 'wet_corrected', v_load.hanger_id, v_load.id, NULL, v_load.batch_id,
    jsonb_build_object('status', v_load.status,
                       'old_wet_g', v_load.wet_g, 'new_wet_g', v_new.wet_g,
                       'old_plant_count', v_load.plant_count, 'new_plant_count', v_new.plant_count));
  RETURN v_new;
END $$;

-- ---- fn_trim_checkout: transition 4 ------------------------------------------------------------
-- hung / dried / partial -> checked_out. NOT from 'returned' (a flagged return blocks reissue until
-- resolved) and not from 'checked_out' (ALREADY_OUT) / reconciled / void.
-- Issues the load's remaining_g and remaining_plant_count (= dry weight for a fresh load) to the
-- trimmer, as the next episode (seq = max + 1); same or different trimmer than before.
-- p_dry_g is accepted ONLY while the load is still 'hung' (it records the dry weight in the same
-- step, hung -> dried -> checked_out); for dried / partial it must be NULL - use fn_trim_record_dry
-- to correct a dry weight. Copies the trimmer's current pay_per_lb and name onto the episode.
-- Returns {"load": <hanger_loads row>, "checkout": <trim_checkouts row>}.
CREATE OR REPLACE FUNCTION public.fn_trim_checkout(
  p_load_id uuid, p_trimmer_id uuid, p_dry_g numeric, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load   public.hanger_loads;
  v_staff  public.trim_staff;
  v_co     public.trim_checkouts;
  v_new    public.hanger_loads;
  v_seq    integer;
  v_from   text;
  v_holder text;
  v_n      integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: load %', p_load_id; END IF;
  v_from := v_load.status;

  IF v_load.status = 'checked_out' THEN
    SELECT trimmer_name INTO v_holder FROM trim_checkouts WHERE load_id = v_load.id AND status = 'out';
    RAISE EXCEPTION 'TRIM_E_ALREADY_OUT: load is already checked out to %', coalesce(v_holder, 'someone');
  ELSIF v_load.status = 'returned' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: the last return is flagged and unresolved - resolve or re-weigh it before reissuing';
  ELSIF v_load.status NOT IN ('hung','dried','partial') THEN
    RAISE EXCEPTION 'TRIM_E_STATE: a % load cannot be checked out', v_load.status;
  END IF;

  SELECT * INTO v_staff FROM trim_staff WHERE id = p_trimmer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: trimmer %', p_trimmer_id; END IF;
  IF NOT v_staff.is_active THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: trimmer % is inactive', v_staff.full_name;
  END IF;

  IF v_load.status = 'hung' THEN
    IF p_dry_g IS NULL OR p_dry_g <= 0 OR p_dry_g > 200000 THEN
      RAISE EXCEPTION 'TRIM_E_INVALID: a hung load needs its dry weight (> 0 and <= 200000 g) to be checked out';
    END IF;
    UPDATE hanger_loads
       SET status = 'dried', dry_g = p_dry_g, dry_recorded_at = now(), dry_recorded_by = p_actor,
           remaining_g = p_dry_g, remaining_plant_count = plant_count, updated_at = now()
     WHERE id = v_load.id AND status = 'hung'
    RETURNING * INTO v_load;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load changed state while recording dry weight'; END IF;
  ELSIF p_dry_g IS NOT NULL THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a dry weight can only be supplied while the load is hung; correct it with the dry-weight action instead';
  END IF;

  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM trim_checkouts WHERE load_id = v_load.id;

  INSERT INTO trim_checkouts (
    load_id, seq, trimmer_id, trimmer_name, status, issued_g, issued_plant_count,
    rate_per_lb_applied, checked_out_by)
  VALUES (
    v_load.id, v_seq, v_staff.id, coalesce(v_staff.display_name, v_staff.full_name), 'out',
    v_load.remaining_g, v_load.remaining_plant_count, v_staff.pay_per_lb, p_actor)
  RETURNING * INTO v_co;

  UPDATE hanger_loads SET status = 'checked_out', updated_at = now()
   WHERE id = v_load.id AND status = v_load.status
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load % changed state during checkout', v_load.id; END IF;

  PERFORM fn_trim_log_event(p_actor, 'checked_out', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', v_from, 'to_status', 'checked_out', 'seq', v_seq,
                       'trimmer_id', v_staff.id, 'trimmer_name', v_co.trimmer_name,
                       'issued_g', v_co.issued_g, 'issued_plant_count', v_co.issued_plant_count,
                       'rate_per_lb_applied', v_co.rate_per_lb_applied,
                       'dry_g_recorded_now', p_dry_g));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co));
END $$;

-- ---- fn_trim_release: transition 5 -------------------------------------------------------------
-- checked_out -> dried (no episode ever returned) or partial (an earlier episode came back
-- unfinished). The released episode keeps its seq (checkouts are never deleted) and is excluded
-- from every figure. Returns {"load": ..., "checkout": ...}.
CREATE OR REPLACE FUNCTION public.fn_trim_release(
  p_checkout_id uuid, p_reason text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load_id uuid;
  v_load    public.hanger_loads;
  v_co      public.trim_checkouts;
  v_new     public.hanger_loads;
  v_next    text;
  v_n       integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT load_id INTO v_load_id FROM trim_checkouts WHERE id = p_checkout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: checkout %', p_checkout_id; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = v_load_id FOR UPDATE;
  SELECT * INTO v_co FROM trim_checkouts WHERE id = p_checkout_id;
  IF v_co.status <> 'out' THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is % - only an outstanding checkout can be released', v_co.status; END IF;
  IF v_load.status <> 'checked_out' THEN RAISE EXCEPTION 'TRIM_E_STATE: load is % , not checked_out', v_load.status; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a release reason of at least 3 characters is required';
  END IF;

  UPDATE trim_checkouts
     SET status = 'released', released_at = now(), released_by = p_actor,
         release_reason = btrim(p_reason), updated_at = now()
   WHERE id = v_co.id AND status = 'out'
  RETURNING * INTO v_co;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is not out'; END IF;

  v_next := CASE WHEN EXISTS (SELECT 1 FROM trim_checkouts WHERE load_id = v_load.id AND status = 'returned')
                 THEN 'partial' ELSE 'dried' END;

  UPDATE hanger_loads SET status = v_next, updated_at = now()
   WHERE id = v_load.id AND status = 'checked_out'
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load is not checked_out'; END IF;

  PERFORM fn_trim_log_event(p_actor, 'released', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', 'checked_out', 'to_status', v_next, 'seq', v_co.seq,
                       'trimmer_name', v_co.trimmer_name, 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co));
END $$;

-- ---- fn_trim_checkin: transitions 6 / 6b / 7 ---------------------------------------------------
-- Records the returned episode. p_return_kind 'complete' (remaining = 0, pass NULL or 0 for the
-- remaining args) or 'unfinished' (p_remaining_g = weight left on the hanger, 0 < x < issued_g;
-- p_remaining_plants >= 1 and <= issued_plant_count when that is known).
-- p_variance_status / p_flag_pct / p_flag_floor_g come from lib/trim/variance.ts; the table's
-- co_ok_within_threshold CHECK refuses an 'ok' that the snapshot says is out of threshold.
-- p_pay_amount (from lib/trim/pay.ts) is required when 'ok' and is ignored when 'flagged'; the
-- pay_amount_matches CHECK verifies it against flower_g * rate.
-- Next load status:  flagged -> 'returned' | complete -> 'reconciled' | unfinished -> 'partial'.
-- An 'ok' return writes its pay entry (status open). A flagged return writes none until resolved.
-- Returns {"load": ..., "checkout": ..., "pay_entry": <row or null>}.
CREATE OR REPLACE FUNCTION public.fn_trim_checkin(
  p_checkout_id uuid, p_return_kind text,
  p_flower_g numeric, p_trim_g numeric, p_stems_g numeric,
  p_variance_status text, p_flag_pct numeric, p_flag_floor_g numeric,
  p_pay_amount numeric, p_actor uuid,
  p_remaining_g numeric DEFAULT NULL, p_remaining_plants integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load_id uuid;
  v_load    public.hanger_loads;
  v_co      public.trim_checkouts;
  v_new     public.hanger_loads;
  v_pay     public.trim_pay_entries;
  v_rem_g   numeric;
  v_rem_pl  integer;
  v_next    text;
  v_n       integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT load_id INTO v_load_id FROM trim_checkouts WHERE id = p_checkout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: checkout %', p_checkout_id; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = v_load_id FOR UPDATE;
  SELECT * INTO v_co FROM trim_checkouts WHERE id = p_checkout_id;
  IF v_co.status <> 'out' THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is % - not out', v_co.status; END IF;
  IF v_load.status <> 'checked_out' THEN RAISE EXCEPTION 'TRIM_E_STATE: load is %, not checked_out', v_load.status; END IF;

  PERFORM fn_trim_assert_return_args(p_return_kind, p_flower_g, p_trim_g, p_stems_g,
            p_remaining_g, p_remaining_plants, v_co.issued_g, v_co.issued_plant_count,
            p_variance_status, p_flag_pct, p_flag_floor_g, p_pay_amount);

  v_rem_g  := CASE WHEN p_return_kind = 'complete' THEN 0 ELSE p_remaining_g END;
  v_rem_pl := CASE WHEN p_return_kind = 'complete' THEN 0 ELSE p_remaining_plants END;
  v_next   := CASE WHEN p_variance_status = 'flagged' THEN 'returned'
                   WHEN p_return_kind = 'complete' THEN 'reconciled'
                   ELSE 'partial' END;

  -- LOAD-BEARING, DO NOT "TIDY": the `AND status = 'out'` / `AND status = 'checked_out'` predicates
  -- in the two UPDATEs below plus the ROW_COUNT checks are the row-count guard (SPRO-131). The
  -- pre-checks above look redundant because the load lock normally makes them sufficient, but the
  -- guard is what still holds if anything writes the rows without taking the load lock, or if state
  -- moves between the read and the write. harvest_trim_smoke.sql proves each predicate is live by
  -- sabotaging the row mid-function (it replaces fn_trim_assert_return_args inside a rolled-back
  -- sub-transaction) - if you remove a predicate that test fails.
  UPDATE trim_checkouts
     SET status = 'returned', return_kind = p_return_kind, returned_at = now(), returned_by = p_actor,
         flower_g = p_flower_g, trim_g = p_trim_g, stems_g = p_stems_g,
         remaining_g = v_rem_g, remaining_plant_count = v_rem_pl,
         variance_status = p_variance_status, flag_pct_applied = p_flag_pct,
         flag_floor_g_applied = p_flag_floor_g, updated_at = now()
   WHERE id = v_co.id AND status = 'out'
  RETURNING * INTO v_co;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is not out'; END IF;

  UPDATE hanger_loads
     SET status = v_next, remaining_g = v_rem_g, remaining_plant_count = v_rem_pl,
         reconciled_at = CASE WHEN v_next = 'reconciled' THEN now() END,
         reconciled_by = CASE WHEN v_next = 'reconciled' THEN p_actor END,
         updated_at = now()
   WHERE id = v_load.id AND status = 'checked_out'
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load is not checked_out'; END IF;

  IF p_variance_status = 'ok' THEN
    INSERT INTO trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount)
    VALUES (v_co.id, v_load.batch_id, v_co.trimmer_id, v_co.flower_g, v_co.rate_per_lb_applied, p_pay_amount)
    RETURNING * INTO v_pay;
  END IF;

  PERFORM fn_trim_log_event(p_actor, 'checked_in', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', 'checked_out', 'to_status', v_next, 'seq', v_co.seq,
      'return_kind', v_co.return_kind, 'trimmer_name', v_co.trimmer_name,
      'issued_g', v_co.issued_g, 'flower_g', v_co.flower_g, 'trim_g', v_co.trim_g, 'stems_g', v_co.stems_g,
      'remaining_g', v_co.remaining_g, 'remaining_plant_count', v_co.remaining_plant_count,
      'processed_g', v_co.processed_g, 'plants_finished', v_co.plants_finished,
      'variance_g', v_co.variance_g, 'variance_pct', v_co.variance_pct,
      'variance_status', v_co.variance_status, 'pay_amount', v_pay.amount));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co),
                            'pay_entry', CASE WHEN v_pay.id IS NULL THEN NULL ELSE to_jsonb(v_pay) END);
END $$;

-- ---- fn_trim_correct_return: transition 8 ------------------------------------------------------
-- Re-weigh the NEWEST returned episode of a load, from load status 'returned' or 'partial'. May
-- change the kind (complete <-> unfinished) and re-evaluates the flag. Older episodes are
-- immutable on purpose (an old mis-weigh surfaces as an opposite-sign variance on the next episode
-- rather than being silently rewritten). A load that is already 'reconciled' must be reopened
-- first (fn_trim_reopen). The episode's pay entry is upserted when the result is 'ok', deleted when
-- it is 'flagged' - but only while that entry is still 'open' (ready / approved => TRIM_E_STATE).
-- Same arguments as fn_trim_checkin. Returns {"load", "checkout", "pay_entry"}.
CREATE OR REPLACE FUNCTION public.fn_trim_correct_return(
  p_checkout_id uuid, p_return_kind text,
  p_flower_g numeric, p_trim_g numeric, p_stems_g numeric,
  p_variance_status text, p_flag_pct numeric, p_flag_floor_g numeric,
  p_pay_amount numeric, p_actor uuid,
  p_remaining_g numeric DEFAULT NULL, p_remaining_plants integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load_id uuid;
  v_load    public.hanger_loads;
  v_co      public.trim_checkouts;
  v_old     public.trim_checkouts;
  v_new     public.hanger_loads;
  v_entry   public.trim_pay_entries;
  v_pay     public.trim_pay_entries;
  v_max_seq integer;
  v_rem_g   numeric;
  v_rem_pl  integer;
  v_next    text;
  v_n       integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT load_id INTO v_load_id FROM trim_checkouts WHERE id = p_checkout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: checkout %', p_checkout_id; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = v_load_id FOR UPDATE;
  SELECT * INTO v_co FROM trim_checkouts WHERE id = p_checkout_id;
  v_old := v_co;

  IF v_co.status <> 'returned' THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is %, not returned', v_co.status; END IF;
  IF v_load.status = 'reconciled' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: load is reconciled - reopen it before correcting the return';
  END IF;
  IF v_load.status NOT IN ('returned','partial') THEN
    RAISE EXCEPTION 'TRIM_E_STATE: load is %, a return can only be corrected from returned or partial', v_load.status;
  END IF;
  SELECT max(seq) INTO v_max_seq FROM trim_checkouts WHERE load_id = v_load.id AND status = 'returned';
  IF v_co.seq <> v_max_seq THEN
    RAISE EXCEPTION 'TRIM_E_STATE: only the newest returned episode (#%) can be corrected, not #%', v_max_seq, v_co.seq;
  END IF;

  PERFORM fn_trim_assert_return_args(p_return_kind, p_flower_g, p_trim_g, p_stems_g,
            p_remaining_g, p_remaining_plants, v_co.issued_g, v_co.issued_plant_count,
            p_variance_status, p_flag_pct, p_flag_floor_g, p_pay_amount);

  -- the pay entry must still be editable before anything is touched
  SELECT * INTO v_entry FROM trim_pay_entries WHERE checkout_id = v_co.id FOR UPDATE;
  IF FOUND AND v_entry.status <> 'open' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: the pay entry for this episode is already % - it cannot be changed', v_entry.status;
  END IF;

  v_rem_g  := CASE WHEN p_return_kind = 'complete' THEN 0 ELSE p_remaining_g END;
  v_rem_pl := CASE WHEN p_return_kind = 'complete' THEN 0 ELSE p_remaining_plants END;
  v_next   := CASE WHEN p_variance_status = 'flagged' THEN 'returned'
                   WHEN p_return_kind = 'complete' THEN 'reconciled'
                   ELSE 'partial' END;

  -- a re-weigh is a fresh evaluation: any earlier acceptance is cleared (it stays in trim_events)
  UPDATE trim_checkouts
     SET return_kind = p_return_kind, returned_at = now(), returned_by = p_actor,
         flower_g = p_flower_g, trim_g = p_trim_g, stems_g = p_stems_g,
         remaining_g = v_rem_g, remaining_plant_count = v_rem_pl,
         variance_status = p_variance_status, flag_pct_applied = p_flag_pct,
         flag_floor_g_applied = p_flag_floor_g,
         variance_reason = NULL, variance_accepted_by = NULL, variance_accepted_at = NULL,
         updated_at = now()
   WHERE id = v_co.id AND status = 'returned'
  RETURNING * INTO v_co;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: checkout is not returned'; END IF;

  UPDATE hanger_loads
     SET status = v_next, remaining_g = v_rem_g, remaining_plant_count = v_rem_pl,
         reconciled_at = CASE WHEN v_next = 'reconciled' THEN now() END,
         reconciled_by = CASE WHEN v_next = 'reconciled' THEN p_actor END,
         updated_at = now()
   WHERE id = v_load.id AND status = v_load.status
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load changed state during correction'; END IF;

  IF p_variance_status = 'ok' THEN
    IF v_entry.id IS NOT NULL THEN
      UPDATE trim_pay_entries
         SET flower_g = v_co.flower_g, rate_per_lb_applied = v_co.rate_per_lb_applied,
             amount = p_pay_amount, updated_at = now()
       WHERE id = v_entry.id AND status = 'open'
      RETURNING * INTO v_pay;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: pay entry is no longer open'; END IF;
    ELSE
      INSERT INTO trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount)
      VALUES (v_co.id, v_load.batch_id, v_co.trimmer_id, v_co.flower_g, v_co.rate_per_lb_applied, p_pay_amount)
      RETURNING * INTO v_pay;
    END IF;
  ELSIF v_entry.id IS NOT NULL THEN
    DELETE FROM trim_pay_entries WHERE id = v_entry.id AND status = 'open';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: pay entry is no longer open'; END IF;
  END IF;

  PERFORM fn_trim_log_event(p_actor, 'return_corrected', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', v_load.status, 'to_status', v_next, 'seq', v_co.seq,
      'before', jsonb_build_object('return_kind', v_old.return_kind, 'flower_g', v_old.flower_g,
        'trim_g', v_old.trim_g, 'stems_g', v_old.stems_g, 'remaining_g', v_old.remaining_g,
        'remaining_plant_count', v_old.remaining_plant_count, 'variance_g', v_old.variance_g,
        'variance_status', v_old.variance_status),
      'after', jsonb_build_object('return_kind', v_co.return_kind, 'flower_g', v_co.flower_g,
        'trim_g', v_co.trim_g, 'stems_g', v_co.stems_g, 'remaining_g', v_co.remaining_g,
        'remaining_plant_count', v_co.remaining_plant_count, 'variance_g', v_co.variance_g,
        'variance_pct', v_co.variance_pct, 'variance_status', v_co.variance_status),
      'pay_amount', v_pay.amount));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co),
                            'pay_entry', CASE WHEN v_pay.id IS NULL THEN NULL ELSE to_jsonb(v_pay) END);
END $$;

-- ---- fn_trim_resolve_variance: transition 9 ----------------------------------------------------
-- Accept a flagged return as-is. Load 'returned' -> 'reconciled' (complete) or 'partial'
-- (unfinished, which unblocks reissue). Reason is mandatory (>= 3 chars) and recorded with the
-- accepting actor. Creates the episode's pay entry from p_pay_amount (lib/trim/pay.ts).
-- Newest returned episode only. Returns {"load", "checkout", "pay_entry"}.
CREATE OR REPLACE FUNCTION public.fn_trim_resolve_variance(
  p_checkout_id uuid, p_reason text, p_pay_amount numeric, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load_id uuid;
  v_load    public.hanger_loads;
  v_co      public.trim_checkouts;
  v_new     public.hanger_loads;
  v_pay     public.trim_pay_entries;
  v_max_seq integer;
  v_next    text;
  v_n       integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT load_id INTO v_load_id FROM trim_checkouts WHERE id = p_checkout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: checkout %', p_checkout_id; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = v_load_id FOR UPDATE;
  SELECT * INTO v_co FROM trim_checkouts WHERE id = p_checkout_id;

  IF v_load.status <> 'returned' THEN RAISE EXCEPTION 'TRIM_E_STATE: load is %, nothing to resolve', v_load.status; END IF;
  IF v_co.status <> 'returned' OR v_co.variance_status <> 'flagged' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: this episode is not a flagged return';
  END IF;
  SELECT max(seq) INTO v_max_seq FROM trim_checkouts WHERE load_id = v_load.id AND status = 'returned';
  IF v_co.seq <> v_max_seq THEN
    RAISE EXCEPTION 'TRIM_E_STATE: only the newest returned episode (#%) can be resolved', v_max_seq;
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a reason of at least 3 characters is required to accept a variance';
  END IF;
  IF p_pay_amount IS NULL OR p_pay_amount < 0 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: pay amount is required';
  END IF;

  v_next := CASE WHEN v_co.return_kind = 'complete' THEN 'reconciled' ELSE 'partial' END;

  UPDATE trim_checkouts
     SET variance_status = 'accepted', variance_reason = btrim(p_reason),
         variance_accepted_by = p_actor, variance_accepted_at = now(), updated_at = now()
   WHERE id = v_co.id AND status = 'returned' AND variance_status = 'flagged'
  RETURNING * INTO v_co;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: episode is no longer flagged'; END IF;

  UPDATE hanger_loads
     SET status = v_next,
         reconciled_at = CASE WHEN v_next = 'reconciled' THEN now() END,
         reconciled_by = CASE WHEN v_next = 'reconciled' THEN p_actor END,
         updated_at = now()
   WHERE id = v_load.id AND status = 'returned'
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load is no longer returned'; END IF;

  INSERT INTO trim_pay_entries (checkout_id, batch_id, trimmer_id, flower_g, rate_per_lb_applied, amount)
  VALUES (v_co.id, v_load.batch_id, v_co.trimmer_id, v_co.flower_g, v_co.rate_per_lb_applied, p_pay_amount)
  RETURNING * INTO v_pay;

  PERFORM fn_trim_log_event(p_actor, 'variance_resolved', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', 'returned', 'to_status', v_next, 'seq', v_co.seq,
      'reason', btrim(p_reason), 'variance_g', v_co.variance_g, 'variance_pct', v_co.variance_pct,
      'pay_amount', v_pay.amount));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co), 'pay_entry', to_jsonb(v_pay));
END $$;

-- ---- fn_trim_reopen: transition 10 -------------------------------------------------------------
-- reconciled -> returned (admin/management in the action layer). Reopens the newest returned
-- (necessarily the complete) episode: its variance status goes back to 'flagged' so the ordinary
-- correct_return / resolve_variance paths apply, and its pay entry is deleted - but ONLY while the
-- entry is still 'open'; once it is ready / approved this raises TRIM_E_STATE (reopen the batch /
-- reverse the payout first). Returns {"load", "checkout"}.
CREATE OR REPLACE FUNCTION public.fn_trim_reopen(
  p_load_id uuid, p_reason text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load  public.hanger_loads;
  v_co    public.trim_checkouts;
  v_old   public.trim_checkouts;
  v_new   public.hanger_loads;
  v_entry public.trim_pay_entries;
  v_n     integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: load %', p_load_id; END IF;
  IF v_load.status <> 'reconciled' THEN
    RAISE EXCEPTION 'TRIM_E_STATE: only a reconciled load can be reopened (is %)', v_load.status;
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a reason of at least 3 characters is required';
  END IF;

  SELECT * INTO v_co FROM trim_checkouts
   WHERE load_id = v_load.id AND status = 'returned' ORDER BY seq DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_STATE: reconciled load has no returned episode'; END IF;
  v_old := v_co;

  SELECT * INTO v_entry FROM trim_pay_entries WHERE checkout_id = v_co.id FOR UPDATE;
  IF FOUND THEN
    IF v_entry.status <> 'open' THEN
      RAISE EXCEPTION 'TRIM_E_STATE: the pay entry is already % - reopen the batch / reverse the payout first', v_entry.status;
    END IF;
    DELETE FROM trim_pay_entries WHERE id = v_entry.id AND status = 'open';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: pay entry is no longer open'; END IF;
  END IF;

  UPDATE trim_checkouts
     SET variance_status = 'flagged', variance_reason = NULL,
         variance_accepted_by = NULL, variance_accepted_at = NULL, updated_at = now()
   WHERE id = v_co.id AND status = 'returned' AND variance_status IN ('ok','accepted')
  RETURNING * INTO v_co;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: episode is not in a reopenable state'; END IF;

  UPDATE hanger_loads
     SET status = 'returned', reconciled_at = NULL, reconciled_by = NULL, updated_at = now()
   WHERE id = v_load.id AND status = 'reconciled'
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load is no longer reconciled'; END IF;

  PERFORM fn_trim_log_event(p_actor, 'reopened', v_load.hanger_id, v_load.id, v_co.id, v_load.batch_id,
    jsonb_build_object('from_status', 'reconciled', 'to_status', 'returned', 'seq', v_co.seq,
      'reason', btrim(p_reason), 'previous_variance_status', v_old.variance_status,
      'previous_variance_reason', v_old.variance_reason, 'deleted_pay_amount', v_entry.amount));
  RETURN jsonb_build_object('load', to_jsonb(v_new), 'checkout', to_jsonb(v_co));
END $$;

-- ---- fn_trim_void: transition 11 + the R2.12 escape hatch --------------------------------------
-- hung / dried -> void   (any caller the action layer admits: trim-ops roles)
-- partial      -> void   ADMIN OR MANAGEMENT ONLY (lib/trim/roles.ts TRIM_ADMIN_ROLES). The function
--                        re-reads the actor's role from public.users (not a caller-supplied flag) and
--                        raises TRIM_E_FORBIDDEN unless it is 'admin' or 'management'. This exists
--                        purely so one stuck hanger can never make a batch permanently unclosable
--                        (and so block trimmer pay); it is not a routine tool. If the role set in
--                        TRIM_ADMIN_ROLES ever changes, change the IN (...) list below to match.
-- Everything else (checked_out, returned, reconciled, void) raises TRIM_E_STATE: a checked-out
-- hanger must be released first, a flagged return resolved first.
-- Reason is mandatory (>= 3 chars). A voided load drops out of every yield figure.
--
-- !! PHASE 3 NOTE (fn_trim_close_batch author, read this) !!
-- Voiding a `partial` load does NOT touch the pay entries / returned episodes it already has: the
-- trimmers really did that work and are owed for it, so those trim_pay_entries rows stay (status
-- open/ready/approved) while the load itself is void. The close-batch reconciliation tripwire
-- "sum(trim_pay_entries.flower_g) = sum(flower_g over returned episodes)" must therefore be computed
-- over the SAME population on both sides - include returned episodes of void loads (or exclude
-- void-load entries from both) - or a voided partial load will make it fail. The smoke script's
-- FINAL pay-entry assertion deliberately does not exclude void loads, as the model for this.
CREATE OR REPLACE FUNCTION public.fn_trim_void(
  p_load_id uuid, p_reason text, p_actor uuid
) RETURNS public.hanger_loads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_load public.hanger_loads;
  v_new  public.hanger_loads;
  v_role text;
  v_eps  integer;
  v_n    integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'TRIM_E_INVALID: actor is required'; END IF;
  SELECT * INTO v_load FROM hanger_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIM_E_NOT_FOUND: load %', p_load_id; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'TRIM_E_INVALID: a void reason of at least 3 characters is required';
  END IF;

  IF v_load.status = 'partial' THEN
    SELECT role INTO v_role FROM users WHERE id = p_actor;
    IF v_role IS NULL OR v_role NOT IN ('admin','management') THEN
      RAISE EXCEPTION 'TRIM_E_FORBIDDEN: only an admin or manager can void a partially trimmed load';
    END IF;
  ELSIF v_load.status NOT IN ('hung','dried') THEN
    RAISE EXCEPTION 'TRIM_E_STATE: a % load cannot be voided (hung and dried can; partial is admin/management-only; release a checked-out load first)', v_load.status;
  END IF;

  SELECT count(*)::integer INTO v_eps FROM trim_checkouts WHERE load_id = v_load.id AND status = 'returned';

  UPDATE hanger_loads
     SET status = 'void', voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason),
         updated_at = now()
   WHERE id = v_load.id AND status = v_load.status
  RETURNING * INTO v_new;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'TRIM_E_STATE: load % changed state while voiding', v_load.id; END IF;

  PERFORM fn_trim_log_event(p_actor, 'voided', v_load.hanger_id, v_load.id, NULL, v_load.batch_id,
    jsonb_build_object('from_status', v_load.status, 'to_status', 'void', 'reason', btrim(p_reason),
                       'remaining_g', v_load.remaining_g, 'remaining_plant_count', v_load.remaining_plant_count,
                       'returned_episodes', v_eps));
  RETURN v_new;
END $$;

-- ============================================================
-- 4. PRIVILEGES: service_role only
-- ============================================================
REVOKE ALL ON FUNCTION public.fn_trim_events_immutable() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_trim_log_event(uuid,text,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_trim_assert_return_args(text,numeric,numeric,numeric,numeric,integer,numeric,integer,text,numeric,numeric,numeric) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_create_hangers(text,integer,integer,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_hangers(text,integer,integer,integer,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_declare_batches(uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_declare_batches(uuid,jsonb,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_create_load(uuid,uuid,integer,numeric,numeric,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_create_load(uuid,uuid,integer,numeric,numeric,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_record_dry(uuid,numeric,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_record_dry(uuid,numeric,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_correct_wet(uuid,numeric,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_correct_wet(uuid,numeric,integer,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_checkout(uuid,uuid,numeric,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_checkout(uuid,uuid,numeric,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_release(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_release(uuid,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_checkin(uuid,text,numeric,numeric,numeric,text,numeric,numeric,numeric,uuid,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_checkin(uuid,text,numeric,numeric,numeric,text,numeric,numeric,numeric,uuid,numeric,integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_correct_return(uuid,text,numeric,numeric,numeric,text,numeric,numeric,numeric,uuid,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_correct_return(uuid,text,numeric,numeric,numeric,text,numeric,numeric,numeric,uuid,numeric,integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_resolve_variance(uuid,text,numeric,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_resolve_variance(uuid,text,numeric,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_reopen(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_reopen(uuid,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_trim_void(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trim_void(uuid,text,uuid) TO service_role;

COMMIT;
