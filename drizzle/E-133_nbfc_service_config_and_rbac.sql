-- E-133 — BRD Addendum V0.2 §7.2 / §7.4. Phase A2 of the Acquire roadmap:
-- per-NBFC Service Opt-In configuration, the per-lead config snapshot that
-- freezes that config when a lead binds to an NBFC, the origination RBAC role
-- guard, and the step-owner (default + city-wise) assignment table.
--
-- Strictly additive + idempotent. The nbfc_users.role CHECK is added NOT VALID
-- so it constrains new / updated rows only and never rejects existing rows that
-- may still carry the legacy telemetry-portal role values.

-- 1. Per-NBFC Service Opt-In + document/track config (§7.4). One row per tenant.
--    An absent row = every service off (the NBFC runs each step off-platform).
CREATE TABLE IF NOT EXISTS "nbfc_service_config" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             uuid NOT NULL,
  "fi_enabled"            boolean NOT NULL DEFAULT false,
  "vkyc_enabled"          boolean NOT NULL DEFAULT false,
  "vkyc_mode"             varchar(16),
  "enach_enabled"         boolean NOT NULL DEFAULT false,
  "enach_handoff_method"  varchar(16),
  "enach_endpoint_url"    text,
  "doc_agreement_method"  varchar(24),
  "store_sanction_letter" boolean NOT NULL DEFAULT false,
  "store_loan_agreement"  boolean NOT NULL DEFAULT false,
  "track_completion_gate" boolean NOT NULL DEFAULT true,
  "track_failure_halts"   boolean NOT NULL DEFAULT false,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_service_config_tenant_unique"
  ON "nbfc_service_config" ("tenant_id");

DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    ADD CONSTRAINT "nbfc_service_config_vkyc_mode_check"
    CHECK ("vkyc_mode" IS NULL OR "vkyc_mode" IN ('own', 'itarang'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_service_config_vkyc_mode_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    ADD CONSTRAINT "nbfc_service_config_enach_handoff_check"
    CHECK ("enach_handoff_method" IS NULL OR "enach_handoff_method" IN ('redirect', 'webhook'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_service_config_enach_handoff_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    ADD CONSTRAINT "nbfc_service_config_agreement_method_check"
    CHECK ("doc_agreement_method" IS NULL OR "doc_agreement_method" IN ('upload', 'digio', 'api_autofetch'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_service_config_agreement_method_check exists';
END; $do$;

-- 2. Per-lead config snapshot (§7.4 — "changes apply to NEW leads only"). The
--    behavioural opt-in toggles in force when the lead bound to the NBFC are
--    frozen here so a later config edit cannot retroactively alter in-flight
--    leads. Nullable: rows created before this migration have no snapshot.
ALTER TABLE "nbfc_lead_assignments"
  ADD COLUMN IF NOT EXISTS "service_config_snapshot" jsonb;

-- 3. Step-owner assignment (§7.2). city IS NULL = the step's default owner;
--    a non-null city is a city-wise override. The owner is notified +
--    accountable; any user holding the role may still act so work doesn't stall.
CREATE TABLE IF NOT EXISTS "nbfc_step_owners" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL,
  "step"       varchar(16) NOT NULL,
  "city"       varchar(120),
  "user_id"    uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $do$ BEGIN
  ALTER TABLE "nbfc_step_owners"
    ADD CONSTRAINT "nbfc_step_owners_step_check"
    CHECK ("step" IN ('fi', 'vkyc', 'enach'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_step_owners_step_check exists';
END; $do$;

-- A NULL city must collapse to a single default per (tenant, step); a plain
-- unique index treats NULLs as distinct, so split into two partial uniques.
CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_step_owners_default_unique"
  ON "nbfc_step_owners" ("tenant_id", "step")
  WHERE "city" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_step_owners_city_unique"
  ON "nbfc_step_owners" ("tenant_id", "step", "city")
  WHERE "city" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "nbfc_step_owners_tenant_idx"
  ON "nbfc_step_owners" ("tenant_id");

-- 4. Origination RBAC role guard (§7.2). NOT VALID so existing rows carrying
--    legacy telemetry-portal roles are not rejected; the guard applies to new /
--    updated rows. Allow-list = the five origination roles ∪ known legacy roles.
DO $do$ BEGIN
  ALTER TABLE "nbfc_users"
    ADD CONSTRAINT "nbfc_users_role_check"
    CHECK ("role" IN (
      'nbfc_admin', 'credit_underwriting', 'fi_coordinator', 'operations', 'viewer',
      'nbfc_manager', 'nbfc_risk_manager', 'nbfc_risk_head', 'nbfc_ops_head',
      'nbfc_credit_manager', 'nbfc_compliance_officer'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_users_role_check exists';
END; $do$;

COMMENT ON TABLE "nbfc_service_config" IS
  'Addendum V0.2 §7.4 — per-NBFC Service Opt-In + document/track config. One row per tenant; absent row = all services off (NBFC handles every step off-platform).';
COMMENT ON COLUMN "nbfc_lead_assignments"."service_config_snapshot" IS
  'Addendum V0.2 §7.4 — frozen copy of the NBFC opt-in toggles at the moment the lead bound to this NBFC. Config edits apply to NEW leads only; in-flight leads read this snapshot.';
COMMENT ON TABLE "nbfc_step_owners" IS
  'Addendum V0.2 §7.2 — per-NBFC step ownership. city IS NULL = default owner for the step; non-null = city-wise override.';
