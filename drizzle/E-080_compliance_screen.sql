-- E-080 — Mandatory compliance metadata renderer for borrower-impacting screens
-- (BRD §6.4.2). RBI Digital Lending Directions 2025 + DPDPA 2023 + FPC require
-- a single source of truth for lender identity, grievance channel, regulatory
-- footer, and data-purpose copy on every borrower-facing screen.
--
-- Two schema changes:
--   1. nbfc_tenants gains four nullable columns for regulatory identity.
--      Nullable so existing rows do not require a backfill before deploy;
--      seeders should populate per-tenant values.
--   2. nbfc_compliance_text — versioned compliance copy keyed by screen.

-- 1. nbfc_tenants — RBI DLD 2025 identity columns
ALTER TABLE "nbfc_tenants"
  ADD COLUMN IF NOT EXISTS "nbfc_legal_name"     varchar(255),
  ADD COLUMN IF NOT EXISTS "rbi_registration_no" varchar(64),
  ADD COLUMN IF NOT EXISTS "grievance_url"       text,
  ADD COLUMN IF NOT EXISTS "grievance_helpline"  varchar(32);

-- 2. nbfc_compliance_text — versioned screen-keyed compliance copy
CREATE TABLE IF NOT EXISTS "nbfc_compliance_text" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"      uuid NOT NULL,
  "screen_key"     varchar(64) NOT NULL,
  "body_text"      text NOT NULL,
  "version"        integer DEFAULT 1 NOT NULL,
  "effective_from" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "nbfc_compliance_text_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "nbfc_tenants"("id")
);

CREATE INDEX IF NOT EXISTS "nbfc_compliance_text_tenant_screen_idx"
  ON "nbfc_compliance_text" ("tenant_id", "screen_key");
CREATE INDEX IF NOT EXISTS "nbfc_compliance_text_effective_idx"
  ON "nbfc_compliance_text" ("effective_from");
