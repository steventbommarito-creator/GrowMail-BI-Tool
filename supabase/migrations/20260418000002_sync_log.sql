-- Run log for every ingestion (USPS EPS pull, Osprey pull, etc.).
-- Powers the "last synced" indicator in the nav and the hygiene page timeline.
--
-- Reverse-engineered from existing prod schema. Idempotent.

CREATE TABLE IF NOT EXISTS sync_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL,              -- 'usps' | 'osprey' | 'manual' | etc.
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  status             text,                       -- 'success' | 'error' | 'running'
  row_count          integer,
  file_size_bytes    bigint,
  error_message      text,
  triggered_by       text,                       -- 'cron' | 'manual' | user email, etc.
  duration_seconds   numeric(10,2)
);

CREATE INDEX IF NOT EXISTS sync_log_source_status_started_idx
  ON sync_log (source, status, started_at DESC);

CREATE INDEX IF NOT EXISTS sync_log_started_at_idx
  ON sync_log (started_at DESC);
