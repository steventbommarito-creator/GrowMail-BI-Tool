-- Cache table for the AI-generated overview summary.
-- The summary is only regenerated when the underlying data changes,
-- detected via a hash of drop counts, postage totals, EPS balance, and deposits.
CREATE TABLE IF NOT EXISTS ai_summary_cache (
  id          integer PRIMARY KEY DEFAULT 1,  -- single-row table
  summary     text NOT NULL,
  data_hash   text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);
