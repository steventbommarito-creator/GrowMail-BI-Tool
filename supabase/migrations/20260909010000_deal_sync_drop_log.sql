-- Per-drop log per order (drop # -> {mail_drop_id, est, act, total}) merged
-- across report windows; rendered into the deal's cf_drop_schedule textarea.
ALTER TABLE osprey_deal_sync ADD COLUMN IF NOT EXISTS drop_log jsonb;
