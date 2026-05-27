-- The bi-automation project accidentally dropped osprey_mail_drops_mail_drop_id_key
-- (the single-column UNIQUE on mail_drop_id) while fixing its own unrelated
-- constraint issues. GrowMail-BI-Tool's insertOsprey.js upserts on mail_drop_id
-- alone (one canonical row per drop), so this constraint is required.
--
-- Also removes the composite (mail_drop_id, capture_date) index that bi-automation
-- added — it is not used here and conflicts with the one-row-per-drop model.

-- Step 1: Remove any duplicate rows created while the unique constraint was missing,
-- keeping only the most recently captured record per mail_drop_id.
DELETE FROM osprey_mail_drops
WHERE id NOT IN (
  SELECT DISTINCT ON (mail_drop_id) id
  FROM osprey_mail_drops
  ORDER BY mail_drop_id, captured_at DESC
);

-- Step 2: Drop the composite index (not used by this project's upsert).
DROP INDEX IF EXISTS osprey_mail_drops_unique;

-- Step 3: Restore the single-column unique constraint that insertOsprey.js relies on.
ALTER TABLE osprey_mail_drops
  ADD CONSTRAINT osprey_mail_drops_mail_drop_id_key UNIQUE (mail_drop_id);
