-- E-134 — BRD Addendum V0.2 §9 (E-NACH Mandate Registration, Model B2-B).
-- The WINNING NBFC owns the mandate lifecycle on its own application /
-- credentials; iTarang only fires the handoff trigger and records the result.
-- iTarang is in no transaction and stores NO bank details or credentials.
--
-- §9.6 data model: one row per registration ATTEMPT. Retries create new rows;
-- the latest row (by created_at) is operative. iTarang keeps its own canonical
-- status (§9.3) — all gates/dashboards read `status`; the provider's raw status
-- is kept alongside for display/audit only and is NEVER branched on.
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS "enach_mandates" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"              varchar(50) NOT NULL,
  "nbfc_id"              integer NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "enach_ref"            varchar(64) NOT NULL,
  -- Canonical state (§9.3) — logic uses only this.
  "status"               varchar(20) NOT NULL DEFAULT 'pending',
  -- Result fields populated on registration (callback or manual).
  "umrn"                 varchar(64),
  "bank_name"            varchar(120),
  "account_masked"       varchar(64),
  "max_amount"           numeric(14, 2),
  "valid_from"           date,
  "valid_to"             date,
  -- Provider raw layer (§9.3) — display/audit only.
  "provider_name"        varchar(80),
  "provider_raw_status"  varchar(120),
  "provider_raw_payload" jsonb,
  -- How the result arrived: the NBFC callback, or an admin manual entry.
  "registration_method"  varchar(16),
  "proof_url"            text,
  "failure_reason"       text,
  -- §9.4 — registered_at + day-90 stale flag (Decentro mandates unpresented
  -- within 120 days become unusable; 120-day rule handed to post-disbursal).
  "stale_risk"           boolean NOT NULL DEFAULT false,
  "registration_date"    timestamptz,
  "triggered_by"         uuid,
  "triggered_at"         timestamptz,
  "registered_at"        timestamptz,
  -- §9.2 — per-lead Credit/Underwriting waiver ("Mark E-NACH Not Required").
  "skip_reason"          text,
  "skipped_by"           uuid,
  "skipped_at"           timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

-- enach_ref is the correlation key for the B2-B callback contract (§9.5).
CREATE UNIQUE INDEX IF NOT EXISTS "enach_mandates_ref_unique"
  ON "enach_mandates" ("enach_ref");

CREATE INDEX IF NOT EXISTS "enach_mandates_lead_nbfc_idx"
  ON "enach_mandates" ("lead_id", "nbfc_id");

CREATE INDEX IF NOT EXISTS "enach_mandates_tenant_status_idx"
  ON "enach_mandates" ("tenant_id", "status");

DO $do$ BEGIN
  ALTER TABLE "enach_mandates"
    ADD CONSTRAINT "enach_mandates_status_check"
    CHECK ("status" IN (
      'not_applicable', 'pending', 'in_progress', 'registered', 'failed', 'skipped'
    ));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: enach_mandates_status_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "enach_mandates"
    ADD CONSTRAINT "enach_mandates_method_check"
    CHECK ("registration_method" IS NULL OR "registration_method" IN ('callback', 'manual'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: enach_mandates_method_check exists';
END; $do$;

COMMENT ON TABLE "enach_mandates" IS
  'Addendum V0.2 §9 — E-NACH mandate registration (Model B2-B). One row per attempt; latest is operative. Canonical status drives all gates; provider_raw_* is display/audit only. No bank credentials are stored by iTarang.';
