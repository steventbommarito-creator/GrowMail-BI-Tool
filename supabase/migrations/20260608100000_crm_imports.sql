-- ============================================================================
-- CRM Imports — Excel→Freshworks bulk loader
-- ----------------------------------------------------------------------------
-- 4 tables that let the user upload a spreadsheet, store every row in the DB
-- with full provenance, map columns to FS fields once, then push rows to FS
-- in user-controlled batches. Built for the "trickle then dump" workflow:
-- send 20 to validate, then 100, then 10,000, then all-remaining.
--
--   crm_imports                — one row per Excel upload (file metadata + mapping)
--   crm_import_rows            — one row per data row from the spreadsheet
--   crm_import_batches         — one row per "Push N records" click
--   crm_account_external_ids   — maps user-assigned external_id → FS account_id
--                                so re-uploading doesn't recreate accounts
-- ============================================================================


-- ─── crm_imports ─────────────────────────────────────────────────────────────
-- One row per uploaded file. Mapping is stored as JSON so each import can have
-- its own column→field mapping without needing schema changes. storage_path
-- references the original file in Supabase Storage (kept for audit + re-parse).
CREATE TABLE IF NOT EXISTS crm_imports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type     text        NOT NULL CHECK (import_type IN
                                ('contacts_accounts', 'leads', 'opportunities', 'tasks')),
  original_filename text,
  storage_path    text,         -- supabase storage object path (bucket = crm-imports)
  total_rows      int         NOT NULL DEFAULT 0,
  sheet_name      text,
  excel_columns   text[],       -- ordered list of source column headers
  mapping_json    jsonb,        -- { "Excel Column Name": "fs_field_name", ... }
  status          text        NOT NULL DEFAULT 'mapping'   -- 'mapping' | 'ready' | 'pushing' | 'complete'
                              CHECK (status IN ('mapping','ready','pushing','complete')),
  uploaded_by     text,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS crm_imports_type_idx ON crm_imports (import_type, uploaded_at DESC);


-- ─── crm_import_rows ─────────────────────────────────────────────────────────
-- One row per spreadsheet data row. raw_json holds the original Excel values
-- exactly as parsed; normalized_json holds whatever the engine produced after
-- normalization (date parsing, smart-quote stripping, etc.). Storing both lets
-- the user download a "failed rows" CSV with the original input so they can
-- fix it in Excel and re-upload.
CREATE TABLE IF NOT EXISTS crm_import_rows (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid        NOT NULL REFERENCES crm_imports(id) ON DELETE CASCADE,
  row_index       int         NOT NULL,                          -- 1-based row number from the Excel
  raw_json        jsonb       NOT NULL,                          -- original values, untouched
  normalized_json jsonb,                                          -- post-normalization, ready for FS
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'validating', 'validation_failed', 'sent', 'failed', 'skipped')),
  fs_id           text,                                           -- FS-side id after successful push
  fs_account_id   text,                                           -- for contacts_accounts type — the linked account id
  error_message   text,
  attempt_count   int         NOT NULL DEFAULT 0,
  batch_id        uuid,                                           -- which batch sent this row (null = not yet)
  attempted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS crm_import_rows_import_idx     ON crm_import_rows (import_id);
CREATE INDEX IF NOT EXISTS crm_import_rows_pending_idx    ON crm_import_rows (import_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crm_import_rows_failed_idx     ON crm_import_rows (import_id, status) WHERE status = 'failed';


-- ─── crm_import_batches ──────────────────────────────────────────────────────
-- One row per user click of "Push N records". Lets us show the import history
-- ("Sent 100 at 11:42, 5 failed; sent 1000 at 11:47, 12 failed; ...") and gives
-- failed rows a batch_id to group their retries.
CREATE TABLE IF NOT EXISTS crm_import_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid        NOT NULL REFERENCES crm_imports(id) ON DELETE CASCADE,
  requested_size  int         NOT NULL,    -- what the user asked for
  actual_size     int,                       -- how many we actually picked (may be smaller if fewer pending)
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running','complete','failed','cancelled')),
  stats_json      jsonb,                     -- { sent, failed, skipped }
  fs_job_ids      text[],                    -- async bulk job ids from FS (for polling)
  triggered_by    text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS crm_import_batches_import_idx ON crm_import_batches (import_id, started_at DESC);


-- ─── crm_account_external_ids ───────────────────────────────────────────────
-- Maps the user-assigned "Account External ID" (a column in their Excel) to
-- the FS sales_account_id we created or upserted. This is the key piece that
-- makes the Contacts+Accounts dedup deterministic: re-uploading the same
-- Excel doesn't create duplicate accounts because we already know that
-- external_id "ACCT-007" maps to FS account 4429.
CREATE TABLE IF NOT EXISTS crm_account_external_ids (
  external_id     text        PRIMARY KEY,
  fs_account_id   text        NOT NULL,
  fs_account_name text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_account_external_ids_fs_idx ON crm_account_external_ids (fs_account_id);
