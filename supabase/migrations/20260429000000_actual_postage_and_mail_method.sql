-- Two new columns on osprey_mail_drops, sourced from the Gordon & Lance
-- finance report. Osprey added "Mail Method" and "Actual Postage" to the
-- report — Actual Postage is the real per-drop cost once production has
-- priced the job, replacing our previous client-side rate-math fallback
-- for LDP Postcards. Mail Method is the categorical mail class
-- ("EDDM", "Saturation", "Targeted Mail", "Ship Only", "LDP", etc.) and
-- is useful both for grouping/reporting and as the implicit reason
-- different drops have different per-piece postage rates.
--
-- The CSV column "Postage Amount" was also renamed to "Est. Postage" by
-- Osprey. We keep the existing column name `postage_amount` here (it's
-- referenced in ~10 places across the dashboard) — the inserter is
-- updated to read from the renamed CSV header, so semantically this
-- column now holds the *estimated* postage and `actual_postage` holds
-- the actual.
--
-- IF NOT EXISTS so this is safe to run on top of existing schema.

ALTER TABLE osprey_mail_drops
  ADD COLUMN IF NOT EXISTS mail_method    TEXT,
  ADD COLUMN IF NOT EXISTS actual_postage NUMERIC;

COMMENT ON COLUMN osprey_mail_drops.mail_method IS
  'Mail class from Osprey Gordon & Lance report — EDDM, Saturation, Targeted Mail, Ship Only, LDP, Inkjet, Warehouse, Digital, Unspecified.';

COMMENT ON COLUMN osprey_mail_drops.actual_postage IS
  'Actual postage cost from Osprey, populated once production has priced the drop. Preferred over postage_amount (which is the estimate) when available.';

COMMENT ON COLUMN osprey_mail_drops.postage_amount IS
  'Estimated postage from Osprey ("Est. Postage" column on the Gordon & Lance report). Use actual_postage when populated; this is the forecast value.';
