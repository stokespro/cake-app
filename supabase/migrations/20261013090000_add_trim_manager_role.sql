-- Harvest & Trim, Phase 0 (1 of 3): add the `trim_manager` role.
-- Plan: .context/harvest-trim-plan.md  (section 2.4, R2.4).
--
-- WHY: Joey (currently role `packaging`) will own the trim station: scanning hangers in and out,
-- accepting variance, setting trimmer pay rates and approving payouts. R2.4 settled on a new role
-- that is a strict superset of `packaging` rather than widening `packaging` (which would hand
-- variance acceptance and rate-setting to any future packaging worker) or giving Joey a second
-- account (which burns a 4-digit PIN and splits the audit actor in two).
--
-- DEPLOY ORDER MATTERS. `users.role` is free text guarded only by this CHECK, and the app fails
-- CLOSED on an unknown role (`isUserRole()` in lib/auth/session-constants.ts): a user holding a
-- role the deployed code does not know cannot log in. So:
--   1. merge Phase 0 so `trim_manager` is in USER_ROLES and Vercel has deployed it,
--   2. apply THIS migration,
--   3. only then assign the role (a one-row execute_sql, NOT a migration file):
--        UPDATE public.users SET role = 'trim_manager'
--         WHERE id = 'fa220b57-817a-49bb-8210-42304283626e' AND role = 'packaging';
--      Rollback is the reverse UPDATE. Joey needs a page refresh (role is cached client-side).
--
-- The constraint list below is the live list as of 2026-10-12
-- (admin|standard|packaging|management|agent|vault|sales|grow) plus `trim_manager`. ADD CONSTRAINT
-- re-validates every existing row, so if any user holds a role outside this list the migration
-- fails atomically instead of narrowing anything silently.
--
-- Do NOT apply manually. Joshua applies via Supabase MCP after the PR merges
-- (merged != applied: verify supabase_migrations.schema_migrations afterwards).

BEGIN;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','management','sales','agent','standard','vault','packaging','grow','trim_manager'));

COMMIT;
