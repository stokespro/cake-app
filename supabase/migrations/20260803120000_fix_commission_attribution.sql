-- SPRO-72: Fix commission attribution and period-dating.
--
-- Problem 1: create_commission_on_delivery() has always credited NEW.agent_id
-- (the user who keyed in the order) rather than the dispensary's assigned
-- salesperson. When an admin/management user enters an order on behalf of a
-- rep, agent_id is stamped as the admin, so the admin (not the rep) gets the
-- commission. Fix: resolve v_salesperson = customers.assigned_sales_id,
-- falling back to NEW.agent_id only when the customer has no assigned rep.
--
-- Problem 2: PATH A (non-terms orders) stores order_date (order-entry date,
-- i.e. the day the order was typed in) as commissions.order_date, so orders
-- entered in one month but delivered/paid in the next land in the wrong
-- reporting period. Fix: use COALESCE(delivered_at, order_date) for PATH A.
-- PATH B (terms orders) already stores terms_paid_at and is left as-is.
--
-- The trigger itself (order_commission_trigger AFTER UPDATE ON public.orders)
-- already exists and is untouched here — only the function body changes via
-- CREATE OR REPLACE. Structure (PATH A / PATH B), the commission_exempt
-- guard, and the dedupe guard are preserved unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_commission_on_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line_item RECORD; v_rate DECIMAL(5,2);
  v_total_commission DECIMAL(10,2) := 0; v_avg_rate DECIMAL(5,2);
  v_salesperson UUID;
BEGIN
  -- PATH A: non-terms order -> delivered (unchanged behavior for all existing orders)
  IF NEW.status = 'delivered'
     AND (OLD.status IS NULL OR OLD.status != 'delivered')
     AND (NEW.payment_terms = FALSE OR NEW.payment_terms IS NULL)
  THEN
    -- Credit the dispensary's assigned rep, not whoever keyed in the order.
    v_salesperson := COALESCE(
      (SELECT assigned_sales_id FROM public.customers WHERE id = NEW.customer_id),
      NEW.agent_id
    );
    IF v_salesperson IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.customer_id AND commission_exempt = TRUE) THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.commissions WHERE order_id = NEW.id) THEN RETURN NEW; END IF;
    FOR v_line_item IN
      SELECT oi.*, s.product_type_id FROM public.order_items oi
      LEFT JOIN public.skus s ON oi.sku_id = s.id WHERE oi.order_id = NEW.id
    LOOP
      -- p_date stays NEW.order_date: it selects which rate schedule was in
      -- effect at order-entry time and is unrelated to the commission
      -- reporting period stored below. Do not change this to delivered_at.
      v_rate := public.get_commission_rate(v_salesperson, v_line_item.sku_id, v_line_item.product_type_id,
                                           v_line_item.unit_price, NEW.order_date::DATE);
      v_total_commission := v_total_commission + ROUND(v_line_item.line_total * (v_rate / 100), 2);
    END LOOP;
    v_avg_rate := CASE WHEN NEW.total_price > 0 THEN ROUND((v_total_commission/NEW.total_price)*100,2) ELSE 0 END;
    INSERT INTO public.commissions (order_id, salesperson_id, order_date, order_total, commission_amount, rate_applied, status)
    VALUES (NEW.id, v_salesperson, COALESCE(NEW.delivered_at::DATE, NEW.order_date::DATE), NEW.total_price, v_total_commission, v_avg_rate, 'pending');

  -- PATH B: terms order -> terms_paid_at goes NULL->value (and order delivered)
  ELSIF NEW.payment_terms = TRUE
        AND NEW.terms_paid_at IS NOT NULL
        AND (OLD.terms_paid_at IS NULL OR OLD.terms_paid_at IS DISTINCT FROM NEW.terms_paid_at)
  THEN
    -- Credit the dispensary's assigned rep, not whoever keyed in the order.
    v_salesperson := COALESCE(
      (SELECT assigned_sales_id FROM public.customers WHERE id = NEW.customer_id),
      NEW.agent_id
    );
    IF v_salesperson IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.customer_id AND commission_exempt = TRUE) THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.commissions WHERE order_id = NEW.id) THEN RETURN NEW; END IF;
    IF NEW.status != 'delivered' THEN RETURN NEW; END IF;
    FOR v_line_item IN
      SELECT oi.*, s.product_type_id FROM public.order_items oi
      LEFT JOIN public.skus s ON oi.sku_id = s.id WHERE oi.order_id = NEW.id
    LOOP
      -- p_date stays NEW.order_date: it selects which rate schedule was in
      -- effect at order-entry time and is unrelated to the commission
      -- reporting period stored below. Do not change this to terms_paid_at.
      v_rate := public.get_commission_rate(v_salesperson, v_line_item.sku_id, v_line_item.product_type_id,
                                           v_line_item.unit_price, NEW.order_date::DATE);
      v_total_commission := v_total_commission + ROUND(v_line_item.line_total * (v_rate / 100), 2);
    END LOOP;
    v_avg_rate := CASE WHEN NEW.total_price > 0 THEN ROUND((v_total_commission/NEW.total_price)*100,2) ELSE 0 END;
    INSERT INTO public.commissions (order_id, salesperson_id, order_date, order_total, commission_amount, rate_applied, status)
    VALUES (NEW.id, v_salesperson, NEW.terms_paid_at::DATE, NEW.total_price, v_total_commission, v_avg_rate, 'pending');
  END IF;
  RETURN NEW;
END; $function$;

COMMENT ON COLUMN public.commissions.order_date IS
'Commission PERIOD date — NOT the order-entry date. For non-terms orders this
is the delivery date (delivered_at); for terms orders it is the date payment
was received (terms_paid_at). Deliberately decoupled from orders.order_date
so that an order typed up in one month but delivered/paid in a later month is
reported in the month it actually closed.';

-- ---------------------------------------------------------------------------
-- Data backfill (SPRO-72), strictly scoped to commissions whose underlying
-- order closed (delivered or terms-paid, falling back to order_date) on or
-- after 2026-06-01. Only 'pending' commissions are touched — approved/paid
-- rows are left alone since they may already be reflected in payouts.
-- Snapshot first so this is reversible.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commissions_backup_spro72 AS
SELECT cm.*, now() AS backed_up_at
FROM public.commissions cm
JOIN public.orders o ON o.id = cm.order_id
WHERE COALESCE(o.terms_paid_at, o.delivered_at, o.order_date) >= '2026-06-01';

-- The snapshot holds payout data. CREATE TABLE AS in the public schema picks up
-- Supabase's default grants, which would make it readable with the anon key.
-- Lock it to service_role only (every server action already uses that client).
ALTER TABLE public.commissions_backup_spro72 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commissions_backup_spro72 FROM anon, authenticated;

-- (a) Reattribute pending commissions to the customer's assigned rep where it
-- differs from who is currently credited. Expected: 19 rows.
UPDATE public.commissions cm
SET salesperson_id = c.assigned_sales_id
FROM public.orders o
JOIN public.customers c ON c.id = o.customer_id
WHERE cm.order_id = o.id
  AND cm.status = 'pending'
  AND COALESCE(o.terms_paid_at, o.delivered_at, o.order_date) >= '2026-06-01'
  AND c.assigned_sales_id IS NOT NULL
  AND cm.salesperson_id IS DISTINCT FROM c.assigned_sales_id;

-- (b) Re-date pending commissions to the order's actual close date
-- (terms-paid, else delivered, else order_date) where it differs from what's
-- currently stored. Expected: 38 rows.
UPDATE public.commissions cm
SET order_date = COALESCE(o.terms_paid_at::DATE, o.delivered_at::DATE, o.order_date::DATE)
FROM public.orders o
WHERE cm.order_id = o.id
  AND cm.status = 'pending'
  AND COALESCE(o.terms_paid_at, o.delivered_at, o.order_date) >= '2026-06-01'
  AND cm.order_date IS DISTINCT FROM COALESCE(o.terms_paid_at::DATE, o.delivered_at::DATE, o.order_date::DATE);

COMMIT;
