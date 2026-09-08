-- Track the last expected_close written per deal so the sync can advance it
-- (next-unmailed-drop date for Running, final mail date for Complete) without
-- re-PUTting every deal each cycle.
ALTER TABLE osprey_deal_sync ADD COLUMN IF NOT EXISTS last_expected_close date;
