-- SPRO-265: dispensary profile DEA number.
--
-- Stored next to omma_license and ob_license as a flat nullable text column.
-- Free text, no format check, same as the other license fields.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS dea_number text;

COMMENT ON COLUMN public.customers.dea_number IS
  'Federal DEA registration number for this dispensary. Free text; null when unknown.';
