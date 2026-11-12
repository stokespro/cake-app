-- SPRO-279: dispensary license document uploads (OMMA, OBN, DEA).
--
-- Do NOT apply manually; Joshua applies via Supabase MCP after merge.
--
-- One active document per (dispensary, type). Replacing a document upserts the
-- row in place. Files live in the private `dispensary-documents` storage bucket
-- and are read through short-lived signed URLs minted server-side.
-- Deleting a customer cascades the rows but NOT the storage objects.

CREATE TABLE IF NOT EXISTS public.dispensary_documents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  dispensary_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('omma', 'obn', 'dea')),
  file_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  expiration_date date,
  uploaded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispensary_documents_one_per_type UNIQUE (dispensary_id, document_type)
);

CREATE TRIGGER update_dispensary_documents_updated_at
  BEFORE UPDATE ON public.dispensary_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Lockdown: all access goes through service-role server actions.
ALTER TABLE public.dispensary_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispensary_documents FROM anon, authenticated;

COMMENT ON TABLE public.dispensary_documents IS
  'License/certificate copies (OMMA, OBN, DEA) per dispensary. One active row per type.';
COMMENT ON COLUMN public.dispensary_documents.file_path IS
  'Object path within the private dispensary-documents bucket: <dispensary_id>/<type>/<ts>-<name>.';
COMMENT ON COLUMN public.dispensary_documents.expiration_date IS
  'Optional expiry date. Stored and displayed only; not enforced.';

-- Private bucket: reads via signed URLs only. No storage policies granted.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'dispensary-documents', 'dispensary-documents', false, 20971520,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
