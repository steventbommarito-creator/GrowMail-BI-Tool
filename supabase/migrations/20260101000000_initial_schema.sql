-- Osprey snapshot registry
CREATE TABLE osprey_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  row_count integer,
  is_backfill boolean DEFAULT false
);

-- Osprey mail drops — one row per mail drop per snapshot
CREATE TABLE osprey_mail_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid REFERENCES osprey_snapshots(id),
  captured_at timestamptz NOT NULL,
  customer_id text,
  customer_name text,
  order_id text,
  product_category text,
  order_quantity integer,
  order_amount numeric(12,2),
  order_status text,
  payment_amount_applied numeric(12,2),
  mail_drop_id text,
  drop_number integer,
  total_drops integer,
  drop_est_date date,
  drop_act_date date,
  mail_drop_quantity integer,
  mail_drop_amount numeric(12,2),
  postage_amount numeric(12,2),
  postage_pct_of_drop numeric(6,4),
  fulfillment_path text,
  print_location text,
  mail_location text,
  seller text,
  is_subscription boolean,
  web_id text,
  capture_date date
);

CREATE UNIQUE INDEX osprey_mail_drops_unique ON osprey_mail_drops(mail_drop_id, capture_date);
CREATE INDEX ON osprey_mail_drops(captured_at);
CREATE INDEX ON osprey_mail_drops(order_status);
CREATE INDEX ON osprey_mail_drops(fulfillment_path);
CREATE INDEX ON osprey_mail_drops(drop_est_date);
CREATE INDEX ON osprey_mail_drops(order_id);
CREATE INDEX ON osprey_mail_drops(mail_drop_id);
CREATE INDEX ON osprey_mail_drops(product_category);

-- USPS transactions — upsert on transaction_number
CREATE TABLE usps_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  transaction_number text UNIQUE NOT NULL,
  account_number text,
  permit_pub text,
  crid text,
  po_of_permit text,
  po_of_mailing text,
  transaction_date date,
  transaction_type text,
  customer_reference_id text,
  eps_tran_number text,
  beginning_balance numeric(12,2),
  amount numeric(12,2),
  ending_balance numeric(12,2),
  pieces integer,
  user_code text,
  open_date date,
  mailer_mailing_date date,
  certification_date date,
  mailing_group_id text,
  job_id text,
  job_description text,
  containers integer,
  stage text,
  mailing_agent text,
  osprey_order_id text,
  osprey_mail_drop_id text
);

CREATE INDEX ON usps_transactions(transaction_date);
CREATE INDEX ON usps_transactions(job_id);
CREATE INDEX ON usps_transactions(osprey_order_id);
CREATE INDEX ON usps_transactions(osprey_mail_drop_id);
CREATE INDEX ON usps_transactions(permit_pub);

-- AI generated insights
CREATE TABLE ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at timestamptz NOT NULL DEFAULT now(),
  insight_type text,
  subject text,
  narrative text,
  data_json jsonb
);
