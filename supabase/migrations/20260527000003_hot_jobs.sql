-- Hot Jobs: lets users flag a mail drop as urgent from the Cashflow tab.
-- One row per mail_drop_id (upsert on conflict). is_hot=true means currently hot.
-- reason is the free-text note entered at the time of flagging.
-- set_by / cleared_by store the user's email so the activity log is attributable.

CREATE TABLE IF NOT EXISTS hot_jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_drop_id text       NOT NULL,
  reason       text,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now(),
  cleared_by   text,
  cleared_at   timestamptz,
  is_hot       boolean     NOT NULL DEFAULT true,
  CONSTRAINT hot_jobs_mail_drop_id_key UNIQUE (mail_drop_id)
);

-- Fast lookup by drop id (covered by the unique constraint, but explicit is clearer)
CREATE INDEX IF NOT EXISTS hot_jobs_mail_drop_id_idx ON hot_jobs (mail_drop_id);

-- Partial index for the "currently hot" read path used by both dashboard pages
CREATE INDEX IF NOT EXISTS hot_jobs_is_hot_idx ON hot_jobs (mail_drop_id) WHERE is_hot = true;
