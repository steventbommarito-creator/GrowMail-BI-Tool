-- ============================================================================
-- CRM Imports — per-import static field values
-- ----------------------------------------------------------------------------
-- Lets the user say "for every row in this import, set this FS field to this
-- value." Independent of the per-row column mapping — useful when:
--
--   • All rows should land in the same lifecycle stage (e.g. tag the entire
--     batch as "Sales Qualified Lead" regardless of source data)
--   • All rows share the same source / owner / territory
--   • You want to stamp a static custom field on every contact in this batch
--     (e.g. "Source = Q2 SF Migration")
--
-- Shape: { fs_field_name: target_value }
--   - For dropdown fields, target_value is the label (string) — engine
--     converts to choice ID via the same path as value mappings.
--   - For text/textarea/date/number fields, target_value is the raw value.
--   - For checkbox fields, target_value is true/false.
--
-- Engine applies static values LAST — after the Excel mapping, the value
-- mapping rules, and the dropdown resolution — so they always win. Mapping
-- a column AND a static for the same field is allowed: the static overrides.
-- ============================================================================

ALTER TABLE crm_imports
  ADD COLUMN IF NOT EXISTS static_values_json jsonb NOT NULL DEFAULT '{}'::jsonb;
