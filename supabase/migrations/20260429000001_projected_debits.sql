-- Projected debits: user-entered forecast of money LEAVING the EPS account on a
-- given date for non-Osprey work — custom postage purchases, special bulk jobs,
-- anything that hits EPS but doesn't show up as a drop in osprey_mail_drops.
-- Symmetric counterpart to projected_deposits.
--
-- The cashflow page treats these as outflows in the running-balance forecast
-- and surfaces them in the Other Debits column of the weekly accounting table.

CREATE TABLE IF NOT EXISTS projected_debits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_date               date NOT NULL UNIQUE,          -- upsert key, mirrors projected_deposits
  amount                   numeric(12,2) NOT NULL,        -- positive value, treated as outflow
  note                     text,
  created_by               text,
  is_active                boolean NOT NULL DEFAULT true,
  cleared_at               timestamptz,                   -- reserved — for future auto-match against EPS
  cleared_by_transaction   date,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projected_debits_active_date_idx
  ON projected_debits (debit_date)
  WHERE is_active = true;

-- Audit trail for manual edits — same shape as projected_deposit_audit so a
-- future combined activity feed can union them by created_at.
CREATE TABLE IF NOT EXISTS projected_debit_audit (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projected_debit_id       uuid REFERENCES projected_debits(id) ON DELETE SET NULL,
  action                   text NOT NULL,                 -- 'create' | 'delete' | 'update'
  previous_amount          numeric(12,2),
  previous_date            date,
  new_amount               numeric(12,2),
  new_date                 date,
  changed_by               text,
  note                     text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projected_debit_audit_created_at_idx
  ON projected_debit_audit (created_at DESC);
