-- E-172 — EMI Tracker: emi_payment_attempts ledger
--
-- One row per auto-debit / collection attempt against an EMI installment. The
-- emi_schedules row holds the installment STATE; this table holds the EVENTS
-- (every debit try, with Razorpay correlation handles + raw payload) for a
-- full RBI-grade audit trail and idempotency.
--
-- The UNIQUE index on idempotency_key is the hard guard against double-debits:
-- the auto-debit cron inserts ON CONFLICT DO NOTHING with a deterministic
-- per-(emi, cycle) key, so overlapping cron ticks can never charge twice.
--
-- Additive + idempotent. Mirrored in src/lib/db/schema.ts (emiPaymentAttempts).

CREATE TABLE IF NOT EXISTS emi_payment_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emi_schedule_id      uuid NOT NULL,
  loan_sanction_id     varchar(255) NOT NULL,
  tenant_id            uuid NOT NULL,
  idempotency_key      varchar(80) NOT NULL,
  -- snapshot of EMI_AUTODEBIT_MODE at attempt time: 'simulate' | 'live' | 'manual'
  mode                 varchar(16) NOT NULL,
  -- 'enach' | 'upi_link' | 'cash'
  channel              varchar(16) NOT NULL,
  razorpay_order_id    varchar(64),
  razorpay_payment_id  varchar(64),
  razorpay_customer_id varchar(64),
  razorpay_token_id    varchar(64),
  amount_paise         integer NOT NULL,
  -- 'initiated' | 'submitted' | 'succeeded' | 'failed' | 'simulated'
  status               varchar(20) NOT NULL,
  provider_raw_status  varchar(120),
  failure_reason       text,
  provider_raw_payload jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Hard double-debit guard.
CREATE UNIQUE INDEX IF NOT EXISTS emi_payment_attempts_idem_uniq
  ON emi_payment_attempts (idempotency_key);

-- Tenant-scoped listing + webhook correlation lookups.
CREATE INDEX IF NOT EXISTS emi_payment_attempts_tenant_idx
  ON emi_payment_attempts (tenant_id);
CREATE INDEX IF NOT EXISTS emi_payment_attempts_emi_idx
  ON emi_payment_attempts (emi_schedule_id);
CREATE INDEX IF NOT EXISTS emi_payment_attempts_order_idx
  ON emi_payment_attempts (razorpay_order_id);
CREATE INDEX IF NOT EXISTS emi_payment_attempts_payment_idx
  ON emi_payment_attempts (razorpay_payment_id);
