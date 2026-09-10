-- Drain queries page pending rows per import ordered by row_index; without an
-- index this is a filtered sort over 240k+ rows per fetch (and cold-cache runs
-- in CI can time out where warm local queries don't).
CREATE INDEX IF NOT EXISTS idx_crm_import_rows_drain
  ON crm_import_rows (import_id, status, row_index);
