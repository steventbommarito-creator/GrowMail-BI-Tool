-- App-wide notifications feed. Written by ingestion scripts, the cashflow page,
-- and the /api/trigger endpoint whenever something noteworthy happens
-- (new deposit cleared, Osprey sync completed, projected deposit edited, etc.).
-- Read by the hygiene page and the nav bell.
--
-- Reverse-engineered from existing prod schema. Idempotent.

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,                   -- e.g. 'deposit_cleared', 'osprey_sync_complete'
  title        text NOT NULL,
  body         text,
  severity     text NOT NULL DEFAULT 'info',    -- 'info' | 'success' | 'warning' | 'error'
  source       text,                            -- 'usps' | 'osprey' | 'manual' | 'system'
  data_json    jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_severity_idx
  ON notifications (severity);
