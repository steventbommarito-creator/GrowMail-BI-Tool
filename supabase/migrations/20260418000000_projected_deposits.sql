-- Projected deposits: user-entered forecast of money coming into the EPS account
-- on a given date (Stripe settlement, FEDWIRE, etc.). Rows are cleared/deactivated
-- automatically by insertUSPS.js when a real deposit lands on the same date.
--
-- Reverse-engineered from existing prod schema (tables already exist in live DB).
-- CREATE ... IF NOT EXISTS keeps this migration idempotent.

CREATE TABLE IF NOT EXISTS projected_deposits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_date             date NOT NULL UNIQUE,          -- upsert key (see cashflow/page.js)
  amount                   numeric(12,2) NOT NULL,
  note                     text,
  created_by               text,
  is_active                boolean NOT NULL DEFAULT true,
  cleared_at               timestamptz,                   -- set by insertUSPS when real deposit matches
  cleared_by_transaction   date,                          -- date of the matching real deposit
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projected_deposits_active_date_idx
  ON projected_deposits (deposit_date)
  WHERE is_active = true;

-- Audit trail for manual edits to projected_deposits (create/delete/amend).
-- Written by cashflow/page.js whenever the user touches a projected deposit.
CREATE TABLE IF NOT EXISTS projected_deposit_audit (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projected_deposit_id     uuid REFERENCES projected_deposits(id) ON DELETE SET NULL,
  action                   text NOT NULL,                 -- 'create' | 'delete' | 'update'
  previous_amount          numeric(12,2),
  previous_date            date,
  new_amount               numeric(12,2),
  new_date                 date,
  changed_by               text,
  note                     text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projected_deposit_audit_created_at_idx
  ON projected_deposit_audit (created_at DESC);
