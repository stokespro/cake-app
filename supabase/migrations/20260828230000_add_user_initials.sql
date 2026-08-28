-- SPRO-115: dispensary map.
--
-- Map pins for claimed and customer dispensaries surface the assigned sales
-- agent. `users` carries a single free-text `name` ("Stokes", "Sam Keathley"),
-- which does not reduce to initials reliably: a first-letter rule collides
-- Sam and Stokes onto "S", and a two-letter rule has nothing to work with on a
-- single-word name. Store the initials explicitly so they are an editable
-- property of the account rather than a guess made at render time.
--
-- Nullable on purpose. Application code derives a fallback from `name` when
-- this is null, so the column is an override, not a requirement — adding a
-- user without initials must never leave a pin unlabelled.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS initials text;

COMMENT ON COLUMN public.users.initials IS
  'Short label for this user on dispensary map pins and compact UI. 1-3 chars. Null falls back to initials derived from name.';

-- Length only. Not restricted to letters: a numeric or punctuated
-- disambiguator ("JS2") is a legitimate way to separate two agents who
-- genuinely share initials.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_initials_length;

ALTER TABLE public.users
  ADD CONSTRAINT users_initials_length
  CHECK (initials IS NULL OR char_length(trim(initials)) BETWEEN 1 AND 3);

-- Seed from the existing names so no account starts blank. Matches the
-- application's derivation exactly: first letter of each of the first two
-- whitespace-separated words, uppercased. Runs once — a re-run of this
-- migration will not clobber initials an admin has since edited.
UPDATE public.users
SET initials = upper(
  CASE
    WHEN array_length(regexp_split_to_array(trim(name), '\s+'), 1) >= 2
      THEN left((regexp_split_to_array(trim(name), '\s+'))[1], 1)
        || left((regexp_split_to_array(trim(name), '\s+'))[2], 1)
    ELSE left(trim(name), 2)
  END
)
WHERE initials IS NULL
  AND coalesce(trim(name), '') <> '';
