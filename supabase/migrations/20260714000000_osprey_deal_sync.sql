-- ============================================================================
-- Osprey (Gordon & Lance) -> Freshworks deal sync state
-- ----------------------------------------------------------------------------
-- One row per Osprey order_id that the sync manages. Lets the recurring sync
-- know each order's last-pushed stage/amount so it only updates a Freshworks
-- deal when something actually changed. New order_id -> new deal; INCOMPLETE
-- orders are skipped (no row created) so they get a deal later if they advance.
-- (Created directly against the DB on 2026-07-14; this file records the schema.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS osprey_deal_sync (
  order_id        text PRIMARY KEY,          -- Osprey Order ID (unique per deal)
  fw_deal_id      text,                        -- Freshworks deal id we created
  customer_id     text,                        -- Osprey Customer ID (account number)
  customer_name   text,
  last_status     text,                        -- last order_status seen
  last_stage_id   bigint,                      -- FW stage id last pushed
  last_amount     numeric,                     -- order_amount last pushed
  fw_account_id   text,                        -- linked FW account (null if none matched)
  excluded        boolean DEFAULT false,
  first_synced_at timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
