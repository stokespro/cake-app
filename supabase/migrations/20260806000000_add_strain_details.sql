-- Adds strain detail fields (logo/background images, THC/terpene ranges) and
-- fixes strain creation, which has been broken since `slug` became NOT NULL
-- UNIQUE with no default and no trigger to populate it (createStrain() only
-- ever inserted `{ name }`).

alter table public.strains add column if not exists logo_url text;
alter table public.strains add column if not exists logo_path text;
alter table public.strains add column if not exists background_url text;
alter table public.strains add column if not exists background_path text;
alter table public.strains add column if not exists thc_min numeric;
alter table public.strains add column if not exists thc_max numeric;
alter table public.strains add column if not exists terpene_min numeric;
alter table public.strains add column if not exists terpene_max numeric;

alter table public.strains alter column type set default 'hybrid';

-- Derives `slug` from `name` when missing, and keeps `updated_at` current.
-- Uniqueness collisions are resolved by appending -2, -3, ... until free
-- (excluding the row being written).
create or replace function public.set_strain_slug()
returns trigger
language plpgsql
as $$
declare
  base_slug text;
  candidate_slug text;
  suffix int := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base_slug := lower(trim(both '-' from regexp_replace(coalesce(new.name, ''), '[^a-zA-Z0-9]+', '-', 'g')));
    base_slug := regexp_replace(base_slug, '-{2,}', '-', 'g');

    if base_slug = '' then
      base_slug := 'strain';
    end if;

    candidate_slug := base_slug;

    while exists (
      select 1 from public.strains
      where slug = candidate_slug
        and id is distinct from new.id
    ) loop
      suffix := suffix + 1;
      candidate_slug := base_slug || '-' || suffix;
    end loop;

    new.slug := candidate_slug;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists set_strain_slug_trigger on public.strains;
create trigger set_strain_slug_trigger
  before insert or update on public.strains
  for each row
  execute function public.set_strain_slug();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'strains_thc_min_range'
  ) then
    alter table public.strains
      add constraint strains_thc_min_range check (thc_min is null or (thc_min >= 0 and thc_min <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'strains_thc_max_range'
  ) then
    alter table public.strains
      add constraint strains_thc_max_range check (thc_max is null or (thc_max >= 0 and thc_max <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'strains_thc_max_gte_min'
  ) then
    alter table public.strains
      add constraint strains_thc_max_gte_min check (thc_min is null or thc_max is null or thc_max >= thc_min);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'strains_terpene_min_range'
  ) then
    alter table public.strains
      add constraint strains_terpene_min_range check (terpene_min is null or (terpene_min >= 0 and terpene_min <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'strains_terpene_max_range'
  ) then
    alter table public.strains
      add constraint strains_terpene_max_range check (terpene_max is null or (terpene_max >= 0 and terpene_max <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'strains_terpene_max_gte_min'
  ) then
    alter table public.strains
      add constraint strains_terpene_max_gte_min check (terpene_min is null or terpene_max is null or terpene_max >= terpene_min);
  end if;
end $$;
