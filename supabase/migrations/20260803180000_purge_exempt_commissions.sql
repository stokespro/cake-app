-- SPRO-72 follow-up: purge commissions for commission_exempt customers.
--
-- customers.commission_exempt (added 2026-07-24, commission_exempt_guard.sql)
-- only guards create_commission_on_delivery() from creating NEW commission
-- rows for exempt accounts. It never removed the commissions that already
-- existed for those accounts before they were flagged exempt. As of this
-- writing there are 56 such rows totalling $7,876.30, created 2026-02-02
-- through 2026-07-24, all in 'pending' status (none approved, none paid).
--
-- Owner decision: if a dispensary is marked commission_exempt, its
-- commissions should be removed entirely, not distributed to anyone.
--
-- Change 1: one-time purge of existing commissions belonging to currently
-- exempt customers, snapshotted first for reversibility, guarded so a
-- 'paid' row can never be clawed back.
--
-- Change 2: a trigger on customers so that the FALSE/NULL -> TRUE
-- transition of commission_exempt self-enforces this going forward,
-- instead of silently accumulating orphaned commissions again. Does NOT
-- run on TRUE -> FALSE (un-exempting) — that is a different, out-of-scope
-- problem (whether/how to re-create commissions), not solved here.

BEGIN;

-- ---------------------------------------------------------------------------
-- Change 1: one-time purge
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commissions_purged_exempt AS
SELECT cm.*, o.order_number, c.business_name, now() AS purged_at
FROM public.commissions cm
JOIN public.orders o ON o.id = cm.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.commission_exempt = TRUE;

-- The snapshot holds payout data. CREATE TABLE AS in the public schema picks
-- up Supabase's default grants, which would make it readable with the anon
-- key. Lock it to service_role only (every server action already uses that
-- client), matching the prior SPRO-72 backup table.
ALTER TABLE public.commissions_purged_exempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commissions_purged_exempt FROM anon, authenticated;

-- Delete the commissions for currently exempt customers. Guarded on
-- status <> 'paid' so this can never claw back money already paid out. All
-- 56 rows in scope today are 'pending', so the guard is a no-op right now —
-- it exists for safety, not because it changes today's result.
DELETE FROM public.commissions cm
USING public.orders o, public.customers c
WHERE cm.order_id = o.id
  AND o.customer_id = c.id
  AND c.commission_exempt = TRUE
  AND cm.status <> 'paid';

-- ---------------------------------------------------------------------------
-- Change 2: self-enforcing going forward — purge on the exempt transition
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purge_commissions_on_exempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.commission_exempt IS TRUE
     AND (OLD.commission_exempt IS DISTINCT FROM NEW.commission_exempt)
  THEN
    DELETE FROM public.commissions cm
    USING public.orders o
    WHERE cm.order_id = o.id
      AND o.customer_id = NEW.id
      AND cm.status <> 'paid';   -- never claw back money already paid
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.purge_commissions_on_exempt() IS
'Fires on customers.commission_exempt FALSE/NULL -> TRUE and deletes that
customer''s existing commissions, excluding any already status = ''paid''
(payouts already made are never clawed back). Deliberately asymmetric: does
NOT fire on TRUE -> FALSE (un-exempting) and does not re-create commissions
that were purged — that is a separate, out-of-scope problem.';

DROP TRIGGER IF EXISTS customers_purge_commissions_on_exempt ON public.customers;
CREATE TRIGGER customers_purge_commissions_on_exempt
  AFTER UPDATE OF commission_exempt ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.purge_commissions_on_exempt();

COMMIT;
