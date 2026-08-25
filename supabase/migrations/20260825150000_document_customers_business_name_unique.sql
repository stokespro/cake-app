-- Documentation-only migration (SPRO-130).
--
-- customers_business_name_idx already exists in the vault project — it was
-- applied out-of-band, most likely during the OMMA customer import dedupe, and
-- was never captured in this folder. Nothing in the repo hinted that renaming a
-- dispensary onto an existing name would be rejected, which is how a 409 from
-- this index ended up being diagnosed as "save silently does nothing".
--
-- IF NOT EXISTS makes this a no-op against production; it exists so the
-- constraint is discoverable from the codebase and so a fresh environment
-- reproduces the same rule.
--
-- The uniqueness is intentional: business names are the human key for the ~1,900
-- customer rows, and chains are disambiguated by suffix
-- (e.g. "GREEN CANOPY SOLUTIONS, INC - CLAREMORE").

CREATE UNIQUE INDEX IF NOT EXISTS customers_business_name_idx
  ON public.customers (lower(business_name));
