-- ============================================================================
-- CRM Imports — Supabase Storage bucket + RLS policies
-- ----------------------------------------------------------------------------
-- The Storage REST API needs a service-role key to create buckets at runtime;
-- we don't have one in the dev env (only a publishable key). The migration
-- runs as the DB owner so it can write to storage.buckets directly. Same
-- pattern Supabase uses in their own template migrations.
-- ============================================================================

-- ─── bucket ─────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-imports',
  'crm-imports',
  false,
  52428800,  -- 50 MB cap per file; well within Supabase tier limits
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/octet-stream'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── RLS policies ────────────────────────────────────────────────────────────
-- Only authenticated users can upload/read/delete files in this bucket. The
-- dashboard runs everything as the signed-in user (Supabase auth cookies on
-- the API routes), so this is enough access control for an internal tool.
DROP POLICY IF EXISTS "crm_imports_select_authenticated"  ON storage.objects;
DROP POLICY IF EXISTS "crm_imports_insert_authenticated"  ON storage.objects;
DROP POLICY IF EXISTS "crm_imports_delete_authenticated"  ON storage.objects;

CREATE POLICY "crm_imports_select_authenticated"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'crm-imports');

CREATE POLICY "crm_imports_insert_authenticated"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-imports');

CREATE POLICY "crm_imports_delete_authenticated"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'crm-imports');
