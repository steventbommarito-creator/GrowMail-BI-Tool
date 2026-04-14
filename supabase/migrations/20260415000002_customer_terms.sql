-- Customer payment terms lookup table.
-- One row per customer_id — seeded from consolidated_customer_terms.xlsx.
-- term_label values: PrePay, NET30, NET45, NET60, NET15, COD, etc.
CREATE TABLE IF NOT EXISTS customer_terms (
  customer_id  text PRIMARY KEY,
  term_label   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_terms_term_label_idx ON customer_terms(term_label);
