-- Planned Drops: a per-drop "I plan to mail this on date X" tag.
-- Set from the Late Mailings tab's Planning Mode (Save Plan button).
-- One row per mail_drop_id; re-saving with a new date overwrites.

CREATE TABLE IF NOT EXISTS planned_drops (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_drop_id  text        NOT NULL,
  planned_date  date        NOT NULL,
  planned_by    text,
  planned_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planned_drops_mail_drop_id_key UNIQUE (mail_drop_id)
);

CREATE INDEX IF NOT EXISTS planned_drops_mail_drop_id_idx ON planned_drops (mail_drop_id);
CREATE INDEX IF NOT EXISTS planned_drops_planned_date_idx ON planned_drops (planned_date);
