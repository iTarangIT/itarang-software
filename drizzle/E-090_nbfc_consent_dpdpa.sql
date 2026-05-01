-- E-090 — DPDPA 2023 consent record persistence + withdrawal.
-- New tables: nbfc_consent_scopes, nbfc_consent_withdrawals.
-- Idempotent: every CREATE/ALTER uses IF NOT EXISTS so the migration is safe
-- to re-run against the sandbox without dropping any existing data.

CREATE TABLE IF NOT EXISTS nbfc_consent_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id varchar(255) NOT NULL,
  scope_key varchar(64) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_consent_scopes_consent_idx
  ON nbfc_consent_scopes (consent_id);

CREATE UNIQUE INDEX IF NOT EXISTS nbfc_consent_scopes_consent_scope_uniq
  ON nbfc_consent_scopes (consent_id, scope_key);

CREATE TABLE IF NOT EXISTS nbfc_consent_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id varchar(255) NOT NULL,
  consent_id varchar(255) NOT NULL,
  withdrawal_channel varchar(32) NOT NULL,
  reason text,
  withdrawn_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbfc_consent_withdrawals_lead_idx
  ON nbfc_consent_withdrawals (lead_id);

CREATE INDEX IF NOT EXISTS nbfc_consent_withdrawals_consent_idx
  ON nbfc_consent_withdrawals (consent_id);
