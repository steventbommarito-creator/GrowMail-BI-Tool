-- ============================================================================
-- Weekly pipeline snapshots — arrival/backfill + quote-conversion history
-- ----------------------------------------------------------------------------
-- osprey_mail_drops is a rolling window (completed drops fall off the Gordon &
-- Lance segment), so per-week pipeline state was never durably retained. This
-- table freezes, at each capture date, what every est-week looked like:
-- how many drops (and how much postage) were known, how many were QUOTE-status,
-- how many were live. After a few weeks of accrual we can compute real
-- arrival curves ("N weeks out we knew X% of the final volume") and quote
-- conversion rates instead of approximating from drop_date_history.
-- Populated by lib/insertOsprey.js on every scrape; one row per
-- (capture_date, est_week), same-day scrapes overwrite (end-of-day state).
-- (Created directly against the DB on 2026-07-22.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS weekly_pipeline_snapshots (
  capture_date      date NOT NULL,
  est_week          date NOT NULL,     -- Sunday of the scheduled week
  weeks_out         int,               -- est_week minus capture week, in weeks
  drop_count        int NOT NULL DEFAULT 0,   -- non-canceled drops scheduled in week
  quote_count       int NOT NULL DEFAULT 0,   -- of those, order_status = QUOTE
  live_count        int NOT NULL DEFAULT 0,   -- of those, is_live_status
  scheduled_postage numeric,
  live_postage      numeric,
  captured_at       timestamptz DEFAULT now(),
  PRIMARY KEY (capture_date, est_week)
);
