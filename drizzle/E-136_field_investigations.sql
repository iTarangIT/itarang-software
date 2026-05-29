-- E-136 — BRD Addendum V0.2 §6.3 (Field Investigation — Locked Basis).
-- An internal NBFC workflow (no external provider): an NBFC-appointed agent
-- physically verifies the customer address. Mandatory for all financed loans.
-- Address verification = text match + physical visit + GPS (~50 m) as
-- SUPPORTING evidence only. 48-hour SLA from agent assignment; re-inspection is
-- NBFC-controlled. Runs as a Stage-1 track across every picked NBFC (§6.1) —
-- one row per (lead × NBFC). FI has NO per-lead skip (§9.2).
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS "field_investigations" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"             varchar(50) NOT NULL,
  "nbfc_id"             integer NOT NULL,
  "tenant_id"          uuid NOT NULL,
  "status"              varchar(20) NOT NULL DEFAULT 'pending',
  "assigned_to"         varchar(200),          -- agent name/identifier (free text)
  "assigned_by"         uuid,
  "assigned_at"         timestamptz,
  "sla_due_at"          timestamptz,           -- assigned_at + 48h (§6.3)
  "sla_breached"        boolean NOT NULL DEFAULT false,
  "visited_at"          timestamptz,
  "address_text_match"  boolean,
  "gps_lat"             numeric(10, 7),
  "gps_lng"             numeric(10, 7),
  "gps_accuracy_m"      numeric(8, 2),
  "agent_notes"         text,
  "outcome"             varchar(10),           -- 'pass' | 'fail'
  "proof_urls"          jsonb,
  "reviewed_by"         uuid,
  "reviewed_at"         timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "field_investigations_lead_nbfc_unique"
  ON "field_investigations" ("lead_id", "nbfc_id");
CREATE INDEX IF NOT EXISTS "field_investigations_tenant_status_idx"
  ON "field_investigations" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "field_investigations_sla_idx"
  ON "field_investigations" ("sla_due_at")
  WHERE "status" IN ('assigned', 'in_progress');

DO $do$ BEGIN
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_status_check"
    CHECK ("status" IN ('not_applicable', 'pending', 'assigned', 'in_progress', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigations_status_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('pass', 'fail'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigations_outcome_check exists';
END; $do$;

COMMENT ON TABLE "field_investigations" IS
  'Addendum V0.2 §6.3 — Field Investigation track, one row per (lead × NBFC). Internal workflow; address = text match + physical visit + GPS (~50 m) supporting only; 48h SLA from assignment; no per-lead skip.';
