-- ============================================================================
-- CRM Integration v1 — Freshworks/Freshsales sync layer
-- ----------------------------------------------------------------------------
-- 5 tables that together let the dashboard stage CRM data without touching
-- Freshworks until the user is ready (Live Sync OFF by default), then push
-- everything in one go (Sync All), then keep things in sync ongoing.
--
-- Tables:
--   crm_settings          — singleton-row config (api creds, pipeline, toggles)
--   crm_status_mappings   — Gordon&Lance order_status → FS deal stage
--   crm_field_mappings    — shell for v2 (G&L column → FS field). created now
--                           so the v2 build doesn't need another migration.
--   crm_synced_deals      — local record of which order → which FS deal_id
--                           (lets us tell create vs update + detect conflicts)
--   crm_events            — activity feed for the Overview page. Auto-pruned
--                           to 90 days like other history tables.
-- ============================================================================


-- ─── crm_settings ────────────────────────────────────────────────────────────
-- One row, ever. Enforced by the `id = 1` CHECK so even an accidental insert
-- without an ON CONFLICT will fail rather than silently create a second config.
-- api_key is plain text per the v1 decision (RLS-gated, internal tool).
CREATE TABLE IF NOT EXISTS crm_settings (
  id                    int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_url               text,
  api_key               text,
  pipeline_id           text,        -- FS pipeline ID (multiple pipelines per FS account)
  pipeline_name         text,        -- cached for display in the Integrations page
  live_sync_enabled     boolean     NOT NULL DEFAULT false,
  last_full_sync_at     timestamptz,
  last_full_sync_by     text,
  last_test_at          timestamptz,
  last_test_ok          boolean,
  last_test_message     text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text
);

-- Insert the empty singleton row so the UI can always upsert against id=1
INSERT INTO crm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ─── crm_status_mappings ─────────────────────────────────────────────────────
-- One row per distinct order_status that appears in osprey_mail_drops.
-- fs_stage_id = NULL means "Don't Sync" (explicit user choice to skip).
-- Absence of a row = "Uncategorized" (not configured yet). The UI distinguishes
-- the two — both end up skipped on sync, but the events log labels them
-- differently so the user can tell intent.
CREATE TABLE IF NOT EXISTS crm_status_mappings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_status    text        NOT NULL UNIQUE,
  fs_stage_id     text,         -- NULL = Don't Sync, set = map to this FS deal stage
  fs_stage_name   text,         -- cached for display so the UI doesn't refetch every render
  fs_stage_category text,       -- 'New' | 'Open' | 'Won' | 'Lost' | 'Other' — the canonical bucket
  excluded        boolean     NOT NULL DEFAULT false,  -- true = Don't Sync (explicit)
  set_by          text,
  set_at          timestamptz NOT NULL DEFAULT now()
);


-- ─── crm_field_mappings ──────────────────────────────────────────────────────
-- v2 shell. Empty for now; v2 will populate after the user lands the field-map UI.
CREATE TABLE IF NOT EXISTS crm_field_mappings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  osprey_column   text        NOT NULL UNIQUE,
  fs_field_name   text        NOT NULL,
  fs_field_type   text,         -- 'string' | 'number' | 'date' | 'custom' | etc.
  set_by          text,
  set_at          timestamptz NOT NULL DEFAULT now()
);


-- ─── crm_synced_deals ────────────────────────────────────────────────────────
-- One row per (order_id ↔ FS deal_id) pair. Used to:
--   • decide create-vs-update on each sync pass
--   • detect FS-side edits via stored fs_updated_at vs the live one
--   • skip no-op pushes via payload_hash comparison
CREATE TABLE IF NOT EXISTS crm_synced_deals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          text        NOT NULL UNIQUE,        -- our side
  fs_deal_id        text        NOT NULL,                -- FS side
  fs_stage_id       text,
  fs_updated_at     timestamptz,                         -- FS-side updated_at as of last sync
  last_payload_hash text,                                -- sha256 of what we last sent — skip push if unchanged
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  last_synced_by    text,                                -- 'cron' | user email
  last_status       text,                                -- 'ok' | 'conflict_skipped' | 'error'
  last_error        text
);

CREATE INDEX IF NOT EXISTS crm_synced_deals_fs_deal_id_idx ON crm_synced_deals (fs_deal_id);
CREATE INDEX IF NOT EXISTS crm_synced_deals_last_status_idx ON crm_synced_deals (last_status);


-- ─── crm_events ──────────────────────────────────────────────────────────────
-- The Overview page reads this top-down. Stays separate from notifications
-- because notifications is the cross-app feed; this one is CRM-specific and
-- carries enough structure (entity_id, before/after JSON) to be auditable.
--
-- event_type catalog (extend as needed):
--   deal_created, deal_updated, deal_skipped_unmapped, deal_skipped_excluded,
--   conflict_detected, sync_started, sync_completed, sync_failed,
--   mapping_changed, settings_changed, live_sync_toggled, test_connection
CREATE TABLE IF NOT EXISTS crm_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text        NOT NULL,
  entity_type   text,         -- 'order' | 'deal' | 'mapping' | 'settings' | NULL
  entity_id     text,         -- e.g. order_id or fs_deal_id
  status        text        NOT NULL DEFAULT 'info',   -- 'info' | 'success' | 'warning' | 'error'
  title         text        NOT NULL,
  body          text,
  data_json     jsonb,        -- before/after, request payload, FS response, etc.
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text          -- 'cron' | user email
);

CREATE INDEX IF NOT EXISTS crm_events_created_at_idx ON crm_events (created_at DESC);
CREATE INDEX IF NOT EXISTS crm_events_event_type_idx ON crm_events (event_type);
CREATE INDEX IF NOT EXISTS crm_events_entity_idx ON crm_events (entity_type, entity_id);


-- ─── Retention ───────────────────────────────────────────────────────────────
-- 90-day cap on crm_events. The Osprey sync cron already runs daily, so we
-- piggyback on it — `lib/crmSync.js` calls this function at the end of each
-- sync pass to keep the table bounded without needing a separate scheduled job.
CREATE OR REPLACE FUNCTION prune_crm_events()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM crm_events WHERE created_at < now() - INTERVAL '90 days';
$$;
