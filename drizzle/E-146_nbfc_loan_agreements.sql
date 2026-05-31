-- E-146 — BRD Addendum V0.2 §11 (Agreement, Document Handling).
--
-- Tracks the sanction-letter / loan-agreement signing for the WINNING NBFC.
-- iTarang facilitates and files but is never a party (§11.1). One row per
-- attempt mirroring enach_mandates (§9.6); the canonical `status` drives the
-- stepper sub-label. Per §11.5 the signed agreement is NOT a disbursal gate —
-- Step-5 OTP is the hard gate — so nothing here blocks disbursal.
--
-- Storage is optional (§11.4): when store_loan_agreement is false iTarang keeps
-- only the §11.6 audit record (loan-exists flag, sanction date), not the PDF.
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS "nbfc_loan_agreements" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"              varchar(50) NOT NULL,
  "nbfc_id"              integer NOT NULL,
  "tenant_id"            uuid NOT NULL,
  "agreement_ref"        varchar(64) NOT NULL,
  -- §11.3 mechanism chosen at onboarding (Document Handling Preferences).
  "method"               varchar(16),   -- 'upload' | 'digio' | 'api_autofetch'
  -- Canonical state — logic/UI reads only this.
  "status"               varchar(20) NOT NULL DEFAULT 'pending',
  "digio_document_id"    varchar(120),
  "signed_document_url"  text,
  "audit_trail_url"      text,
  -- Provider raw layer (display/audit only).
  "provider_raw_status"  varchar(120),
  "provider_raw_payload" jsonb,
  -- §11.4 storage opt-in snapshot so the §11.6 audit record is self-describing.
  "store_sanction_letter" boolean NOT NULL DEFAULT false,
  "store_loan_agreement"  boolean NOT NULL DEFAULT false,
  "failure_reason"       text,
  "initiated_by"         uuid,
  "initiated_at"         timestamptz,
  "signed_at"            timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_loan_agreements_ref_unique"
  ON "nbfc_loan_agreements" ("agreement_ref");

CREATE INDEX IF NOT EXISTS "nbfc_loan_agreements_lead_nbfc_idx"
  ON "nbfc_loan_agreements" ("lead_id", "nbfc_id");

CREATE INDEX IF NOT EXISTS "nbfc_loan_agreements_digio_doc_idx"
  ON "nbfc_loan_agreements" ("digio_document_id");

DO $do$ BEGIN
  ALTER TABLE "nbfc_loan_agreements"
    ADD CONSTRAINT "nbfc_loan_agreements_status_check"
    CHECK ("status" IN ('pending', 'in_progress', 'signed', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: status check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_loan_agreements"
    ADD CONSTRAINT "nbfc_loan_agreements_method_check"
    CHECK ("method" IS NULL OR "method" IN ('upload', 'digio', 'api_autofetch'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: method check exists';
END; $do$;

COMMENT ON TABLE "nbfc_loan_agreements" IS
  'Addendum V0.2 §11 — sanction-letter / loan-agreement signing. One row per attempt. Not a disbursal gate (§11.5 OTP is). Storage optional (§11.4).';
