-- E-181 — EMI Tracker per-loan display overrides.
--
-- Lets an NBFC operator manually override any column shown in the EMI Tracker
-- portfolio table (/nbfc/emi-tracker). This is a DISPLAY layer only: the row
-- keys off nbfc_loans.loan_application_id and each column is nullable — a NULL
-- means "no override, show the computed/stored value". The page query
-- COALESCEs override → computed, so canonical records (leads.full_name,
-- loan_sanctions.emi, emi_schedules, current_dpd, enach_mandates) are never
-- mutated and clearing an override reverts to the live computed value.
--
-- Strictly additive. Idempotent.

CREATE TABLE IF NOT EXISTS nbfc_emi_tracker_overrides (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  loan_application_id varchar(255) NOT NULL,
  -- Per-column overrides (NULL = fall back to computed/stored value).
  borrower            text,
  vehicleno           text,
  emi                 numeric(12, 2),
  next_due            date,
  last_paid           date,
  progress_paid       integer,
  progress_total      integer,
  status              varchar(16),   -- active | overdue | closed
  dpd                 integer,
  mandate             varchar(30),   -- registered | none | <raw status>
  next_auto_debit     date,
  updated_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One override row per (tenant, loan) — the API upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_emi_tracker_overrides_tenant_loan_uidx
  ON nbfc_emi_tracker_overrides (tenant_id, loan_application_id);
