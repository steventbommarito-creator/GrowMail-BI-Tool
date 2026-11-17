-- "Create Invoice Alert" log for the Invoicing Report.
-- One row per mail_drop_id once the drop reaches Osprey status 700 (COMPLETE,
-- tax processed) for a customer on terms. line_items is the drop's rows from
-- Osprey's NetSuite check report ([{ product, quantity, amount }]) — what goes
-- on the invoice. source='live' rows are emailed by invoice-alerts.js
-- (email_sent_at set once Resend accepts it); source='backfill' rows were
-- loaded for the dashboard only and never emailed.

CREATE TABLE IF NOT EXISTS invoice_alerts (
  mail_drop_id   text        PRIMARY KEY,
  order_id       text        NOT NULL,
  customer_id    text,
  customer_name  text,
  term_label     text,
  brand          text,
  order_label    text,
  mail_method    text,
  drop_act_date  date,
  line_items     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  total_amount   numeric(12,2),
  source         text        NOT NULL DEFAULT 'live',
  email_sent_at  timestamptz,
  email_id       text,
  email_error    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- No RLS, like the other job-written tables (sync_log, osprey_deal_sync, …):
-- the scraper jobs write with the anon key.
