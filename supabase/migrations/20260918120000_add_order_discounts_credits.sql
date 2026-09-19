-- SPRO-148: persistent order-level flat-dollar discounts and credits.
--
-- Additive only — every historical order keeps its existing total_price and
-- gets NULL for all four new columns, which satisfies both pair constraints.
--
-- Pair rule (mirrored in lib/orders/deductions.ts — keep the two in sync):
-- each amount/reason pair is either BOTH NULL, or a strictly positive amount
-- plus a trimmed non-blank reason of at most 255 characters.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS discount_reason TEXT,
  ADD COLUMN IF NOT EXISTS credit_amount   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS credit_reason   TEXT;

COMMENT ON COLUMN public.orders.discount_amount IS 'SPRO-148: flat-dollar order-level discount. NULL = no discount. Deducted from the active line-item subtotal to produce total_price.';
COMMENT ON COLUMN public.orders.discount_reason IS 'SPRO-148: short required justification for discount_amount (<=255 chars, non-blank). NULL iff discount_amount IS NULL.';
COMMENT ON COLUMN public.orders.credit_amount   IS 'SPRO-148: flat-dollar order-level credit. NULL = no credit. Deducted from the active line-item subtotal to produce total_price.';
COMMENT ON COLUMN public.orders.credit_reason   IS 'SPRO-148: short required justification for credit_amount (<=255 chars, non-blank). NULL iff credit_amount IS NULL.';

-- Dropped and re-added rather than added conditionally, so re-running the
-- migration always leaves the CURRENT definition in place.
--
-- The `amount IS NOT NULL` term is load-bearing and must not be "simplified"
-- away as implied by `amount > 0`: with a NULL amount and a non-NULL reason,
-- `amount > 0` evaluates to NULL, the whole CHECK evaluates to NULL, and
-- Postgres treats a NULL CHECK as SATISFIED — which would let an orphan
-- reason with no amount through. The explicit IS NOT NULL forces FALSE.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_discount_pair_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_discount_pair_check CHECK (
    (discount_amount IS NULL AND discount_reason IS NULL)
    OR (
      discount_amount IS NOT NULL
      AND discount_amount > 0
      AND discount_reason IS NOT NULL
      AND btrim(discount_reason) <> ''
      AND char_length(btrim(discount_reason)) <= 255
    )
  );

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_credit_pair_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_credit_pair_check CHECK (
    (credit_amount IS NULL AND credit_reason IS NULL)
    OR (
      credit_amount IS NOT NULL
      AND credit_amount > 0
      AND credit_reason IS NOT NULL
      AND btrim(credit_reason) <> ''
      AND char_length(btrim(credit_reason)) <= 255
    )
  );
