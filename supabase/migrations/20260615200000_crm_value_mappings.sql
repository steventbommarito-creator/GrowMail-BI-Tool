-- ============================================================================
-- CRM Imports — per-import value mapping
-- ----------------------------------------------------------------------------
-- For each (excel_col, fs_field) where fs_field is a dropdown, the user can
-- define value translations. Example: column 'lead_status' targets FS field
-- 'contact_status_id'; rules:
--     "New Lead"     → "New"
--     "Disqualified" → "Unqualified"
--     "Not Ready"    → null    (skip the field — don't send to FS)
--
-- Stored as nested JSON, keyed by excel_col then fs_field:
--   {
--     "lead_status": {
--       "contact_status_id": {
--         "New Lead": "New",
--         "Disqualified": "Unqualified",
--         "Not Ready": null
--       }
--     }
--   }
-- Engine applies these BEFORE the dropdown text→ID resolution so the user's
-- terminology gets rewritten to the FS canonical label, which is then
-- resolved to the choice ID. Without a rule, the raw value passes through
-- (and will fail dropdown resolution if it doesn't already match a choice).
-- ============================================================================

ALTER TABLE crm_imports
  ADD COLUMN IF NOT EXISTS value_mappings_json jsonb NOT NULL DEFAULT '{}'::jsonb;
