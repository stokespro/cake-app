-- Lab results (COA) PDF attached to a batch.
-- Stored in the public `lab-results` storage bucket so the marketing site can
-- render it and CRM users can share the link with customers.

alter table public.batches
  add column if not exists coa_url text,
  add column if not exists coa_path text,
  add column if not exists coa_filename text,
  add column if not exists coa_uploaded_at timestamptz,
  add column if not exists coa_uploaded_by uuid references public.users(id) on delete set null;

comment on column public.batches.coa_url is 'Public URL of the lab results (COA) PDF in the lab-results storage bucket.';
comment on column public.batches.coa_path is 'Storage object path within the lab-results bucket; used to replace/delete the file.';
comment on column public.batches.coa_filename is 'Original filename of the uploaded COA PDF, shown in the UI and used for downloads.';
comment on column public.batches.coa_uploaded_at is 'When the current COA PDF was uploaded.';
comment on column public.batches.coa_uploaded_by is 'User who uploaded the current COA PDF.';

-- Public bucket for lab result PDFs. Public read (COAs are meant to be shared);
-- writes only ever happen via service-role-issued signed upload URLs, so no
-- anon insert/update/delete policy is granted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-results', 'lab-results', true, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
