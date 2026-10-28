-- SPRO-235: make packages.batch_id NOT NULL.
--
-- APPLY ONLY AFTER the code deploy that writes batch_id, and after confirming zero NULLs:
--   SELECT count(*) FROM public.packages WHERE batch_id IS NULL;   -- must be 0
ALTER TABLE public.packages ALTER COLUMN batch_id SET NOT NULL;
