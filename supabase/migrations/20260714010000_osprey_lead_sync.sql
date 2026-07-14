-- ============================================================================
-- Osprey new-users -> Freshworks leads: sync state
-- ----------------------------------------------------------------------------
-- One row per Osprey user we've evaluated. max(user_id) is the watermark: each
-- run only processes users above it (new signups). First run seeds the last 30
-- days. outcome records what happened (created a lead / already existed / no
-- usable email). (Created directly against the DB on 2026-07-14.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS osprey_lead_sync (
  user_id           bigint PRIMARY KEY,       -- Osprey user_id (watermark source)
  email             text,
  fw_contact_id     text,                       -- FW lead/contact id (when created)
  outcome           text,                       -- created | exists | no_email
  osprey_created_at timestamptz,
  synced_at         timestamptz DEFAULT now()
);
