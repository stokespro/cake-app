-- Enable Supabase Realtime for the tables backing the Packaging Board (v2).
-- Required so the board can refetch on live changes instead of relying on a
-- 150s poll interval. Mirrors the pattern established in
-- 20260615000000_enable_realtime_orders.sql for orders/order_items.
--
-- Live-schema verified via Supabase Management API before writing this
-- migration (2026-07-21):
--   - `inventory` is a BASE TABLE (not a view) — safe to publish directly.
--     table_type: BASE TABLE (information_schema.tables)
--   - `containers`, `packaging_task_state`, `packaging_claims`, `task_notes`
--     are all BASE TABLEs.
--   - None of these tables (nor orders/order_items) currently grant SELECT
--     to the `anon` or `authenticated` Postgres roles — RLS is enabled with
--     zero policies. This means postgres_changes events still fire for an
--     anon-key subscriber, but arrive with an empty payload and a
--     "401: Unauthorized" marker (verified empirically against task_notes).
--     That is sufficient for our use case: the client only uses the event
--     as a "something changed, refetch via the authorized server action"
--     signal — it never reads row content off the realtime payload
--     (the allocation engine / board data is always recomputed server-side
--     with the service-role client, per lib/packaging/db.ts and
--     actions/packaging-board.ts). No GRANT/RLS policy changes are made
--     here to keep this change minimal and consistent with the existing
--     orders/order_items realtime setup.

alter publication supabase_realtime add table containers;
alter publication supabase_realtime add table packaging_task_state;
alter publication supabase_realtime add table packaging_claims;
alter publication supabase_realtime add table task_notes;
alter publication supabase_realtime add table inventory;
