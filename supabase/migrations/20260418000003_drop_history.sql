-- Append-only history tables for Osprey mail drops. Written by lib/insertOsprey.js
-- on every sync when a drop's status or scheduled/actual date changes from the
-- prior snapshot. Used to reconstruct "when did this drop slip" timelines.
--
-- Reverse-engineered from existing prod schema. Idempotent.

CREATE TABLE IF NOT EXISTS drop_status_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_drop_id  text NOT NULL,
  order_id      text,
  status        text NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  snapshot_id   uuid
);

CREATE INDEX IF NOT EXISTS drop_status_history_drop_observed_idx
  ON drop_status_history (mail_drop_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS drop_status_history_snapshot_idx
  ON drop_status_history (snapshot_id);

CREATE TABLE IF NOT EXISTS drop_date_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_drop_id     text NOT NULL,
  order_id         text,
  scheduled_date   date,
  actual_date      date,
  snapshot_id      uuid,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  changed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drop_date_history_drop_changed_idx
  ON drop_date_history (mail_drop_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS drop_date_history_snapshot_idx
  ON drop_date_history (snapshot_id);
