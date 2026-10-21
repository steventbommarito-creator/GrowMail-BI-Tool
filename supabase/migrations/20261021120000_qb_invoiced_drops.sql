-- QuickBooks invoicing status for the Invoicing Report.
-- One row per mail_drop_id (upsert on conflict). is_invoiced=true means the drop
-- is currently marked "Invoiced in QuickBooks"; unmarking flips it to false and
-- records cleared_by/cleared_at. Every mark/unmark is also logged to notifications.

CREATE TABLE IF NOT EXISTS qb_invoiced_drops (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_drop_id   text        NOT NULL,
  invoice_number text,
  invoiced_by    text,
  invoiced_at    timestamptz NOT NULL DEFAULT now(),
  cleared_by     text,
  cleared_at     timestamptz,
  is_invoiced    boolean     NOT NULL DEFAULT true,
  CONSTRAINT qb_invoiced_drops_mail_drop_id_key UNIQUE (mail_drop_id)
);

CREATE INDEX IF NOT EXISTS qb_invoiced_drops_is_invoiced_idx ON qb_invoiced_drops (mail_drop_id) WHERE is_invoiced = true;

ALTER TABLE qb_invoiced_drops ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qb_invoiced_drops_authenticated_all ON qb_invoiced_drops;
CREATE POLICY qb_invoiced_drops_authenticated_all ON qb_invoiced_drops
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
