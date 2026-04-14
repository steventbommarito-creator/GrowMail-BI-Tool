-- Migration: deduplicate osprey_mail_drops and switch to one-row-per-drop upsert
--
-- Background: the previous upsert used onConflict(mail_drop_id, capture_date),
-- so every sync run inserted a new row per drop. This caused duplicates across
-- all dashboard reports. We now keep one canonical row per mail_drop_id,
-- updated in-place on each sync so the status always reflects the latest state.

-- Step 1: Remove duplicate rows, keeping only the most recently captured
-- record for each mail_drop_id
DELETE FROM osprey_mail_drops
WHERE id NOT IN (
  SELECT DISTINCT ON (mail_drop_id) id
  FROM osprey_mail_drops
  ORDER BY mail_drop_id, captured_at DESC
);

-- Step 2: Drop the composite unique index
DROP INDEX IF EXISTS osprey_mail_drops_unique;

-- Step 3: Add a unique constraint on mail_drop_id alone
ALTER TABLE osprey_mail_drops
  ADD CONSTRAINT osprey_mail_drops_mail_drop_id_key UNIQUE (mail_drop_id);
