-- Add columns that live in prod but were never captured in the initial migration.
-- The ingestion code (lib/insertUSPS.js, lib/insertOsprey.js) already writes to
-- these columns and dashboard code reads from them; this migration just reconciles
-- the schema-as-code with reality so a clean DB can be stood up from migrations alone.
--
-- ADD COLUMN IF NOT EXISTS keeps this safe to run against the live DB.

-- usps_transactions: classification flags written by insertUSPS.js
ALTER TABLE usps_transactions
  ADD COLUMN IF NOT EXISTS is_dmm              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_deposit          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transaction_bucket  text;

CREATE INDEX IF NOT EXISTS usps_transactions_bucket_idx
  ON usps_transactions (transaction_bucket);

CREATE INDEX IF NOT EXISTS usps_transactions_is_deposit_idx
  ON usps_transactions (is_deposit)
  WHERE is_deposit = true;

-- osprey_mail_drops: status/flag columns written by insertOsprey.js and read everywhere
ALTER TABLE osprey_mail_drops
  ADD COLUMN IF NOT EXISTS drop_status         text,
  ADD COLUMN IF NOT EXISTS is_live_status      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS delivery_flag       text,                 -- 'on_time' | 'late'
  ADD COLUMN IF NOT EXISTS production_amount   numeric(12,2);

CREATE INDEX IF NOT EXISTS osprey_mail_drops_drop_status_idx
  ON osprey_mail_drops (drop_status);

CREATE INDEX IF NOT EXISTS osprey_mail_drops_is_live_idx
  ON osprey_mail_drops (is_live_status)
  WHERE is_live_status = true;
